/**
 * Command Anti-Spam Guard
 * Melindungi akun WhatsApp pribadi dari mekanisme deteksi spam WhatsApp
 * sekaligus mencegah beban berlebih (Denial of Service) pada peladen
 * ketika perintah utilitas dapat diakses oleh semua lawan bicara.
 *
 * Lapisan perlindungan:
 * 1. Jeda alami (human-like jitter) sebelum membalas lawan bicara
 * 2. Cooldown per pengirim (lebih ketat untuk nomor tak terdaftar & perintah media)
 * 3. Kuota jendela geser (per 10 menit dan per jam)
 * 4. Silent drop pasca 1 kali balasan peringatan + penalti bisu 30 menit bila tetap flood
 * 5. Circuit breaker global (balasan/menit, balasan/jam ke nomor asing, nomor asing baru/jam)
 * 6. Pembatas konkurensi pemrosesan media Sharp (maksimal 2 paralel)
 */

const ONE_MINUTE_MS = 60 * 1000;
const TEN_MINUTES_MS = 10 * 60 * 1000;
const ONE_HOUR_MS = 60 * 60 * 1000;

function parseEnvInt(name, fallback) {
  const parsed = parseInt(process.env[name], 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

class CommandAntiSpamGuard {
  constructor(options = {}) {
    this.knownCooldownMs = options.knownCooldownMs ?? parseEnvInt('CMD_KNOWN_COOLDOWN_MS', 3000);
    this.knownMaxPer10Min = options.knownMaxPer10Min ?? parseEnvInt('CMD_KNOWN_MAX_10MIN', 20);

    this.unknownTextCooldownMs =
      options.unknownTextCooldownMs ?? parseEnvInt('CMD_UNKNOWN_TEXT_COOLDOWN_MS', 6000);
    this.unknownMediaCooldownMs =
      options.unknownMediaCooldownMs ?? parseEnvInt('CMD_UNKNOWN_MEDIA_COOLDOWN_MS', 10000);
    this.unknownMaxPer10Min =
      options.unknownMaxPer10Min ?? parseEnvInt('CMD_UNKNOWN_MAX_10MIN', 5);
    this.unknownMaxPerHour =
      options.unknownMaxPerHour ?? parseEnvInt('CMD_UNKNOWN_MAX_HOUR', 15);

    this.floodStrikeThreshold = options.floodStrikeThreshold ?? 3;
    this.muteDurationMs = options.muteDurationMs ?? parseEnvInt('CMD_FLOOD_MUTE_MS', 30 * 60 * 1000);

    this.globalMaxPerMinute =
      options.globalMaxPerMinute ?? parseEnvInt('CMD_GLOBAL_MAX_MIN', 15);
    this.unknownGlobalMaxPerHour =
      options.unknownGlobalMaxPerHour ?? parseEnvInt('CMD_UNKNOWN_GLOBAL_MAX_HOUR', 40);
    this.maxNewUnknownSendersPerHour =
      options.maxNewUnknownSendersPerHour ?? parseEnvInt('CMD_MAX_NEW_UNKNOWN_HOUR', 10);

    // Perlindungan khusus grup agar satu grup ramai tidak memicu spam balasan keluar
    this.groupCooldownMs = options.groupCooldownMs ?? parseEnvInt('CMD_GROUP_COOLDOWN_MS', 5000);
    this.groupMaxPer10Min = options.groupMaxPer10Min ?? parseEnvInt('CMD_GROUP_MAX_10MIN', 15);

    this.knownJitterRange = options.knownJitterRange ?? [700, 1500];
    this.unknownJitterRange = options.unknownJitterRange ?? [1200, 2500];

    this.maxConcurrentMedia = options.maxConcurrentMedia ?? 2;
    this.maxQueuedMedia = options.maxQueuedMedia ?? 5;
    this.addLog = options.addLog || (() => {});

    // State per pengirim: Map<senderKey, {...}>
    this.senderStates = new Map();
    // State per grup: Map<groupJid, { lastCommandAt, timestamps10Min, warnedForCurrentLimit }>
    this.groupStates = new Map();
    // Riwayat global non-pemilik
    this.globalMinuteTimestamps = [];
    this.unknownHourTimestamps = [];
    this.unknownFirstSeenMap = new Map(); // senderKey -> firstTimestamp dalam 1 jam terakhir
    this.lastCircuitBreakerLogAt = 0;

    // Antrean slot pemrosesan media
    this.activeMediaJobs = 0;
    this.mediaWaitQueue = [];
  }

  getRandomBetween(min, max) {
    if (max <= min) return min;
    return Math.floor(Math.random() * (max - min + 1)) + min;
  }

  pruneOldEntries(nowMs) {
    this.globalMinuteTimestamps = this.globalMinuteTimestamps.filter(
      (t) => nowMs - t < ONE_MINUTE_MS
    );
    this.unknownHourTimestamps = this.unknownHourTimestamps.filter(
      (t) => nowMs - t < ONE_HOUR_MS
    );

    for (const [key, seenAt] of this.unknownFirstSeenMap.entries()) {
      if (nowMs - seenAt >= ONE_HOUR_MS) {
        this.unknownFirstSeenMap.delete(key);
      }
    }

    if (this.senderStates.size > 300) {
      for (const [key, state] of this.senderStates.entries()) {
        const lastActivity = Math.max(state.lastCommandAt || 0, state.mutedUntil || 0);
        if (nowMs - lastActivity > 2 * ONE_HOUR_MS) {
          this.senderStates.delete(key);
        }
      }
    }
  }

  getOrCreateSenderState(senderKey) {
    let state = this.senderStates.get(senderKey);
    if (!state) {
      state = {
        lastCommandAt: 0,
        timestamps10Min: [],
        timestampsHour: [],
        blockedStrikes: [],
        warnedForCurrentLimit: false,
        mutedUntil: 0
      };
      this.senderStates.set(senderKey, state);
    }
    return state;
  }

  recordBlockedStrike(state, senderKey, isKnown, nowMs) {
    state.blockedStrikes = state.blockedStrikes.filter((t) => nowMs - t < ONE_MINUTE_MS);
    state.blockedStrikes.push(nowMs);

    if (!isKnown && state.blockedStrikes.length >= this.floodStrikeThreshold) {
      state.mutedUntil = nowMs + this.muteDurationMs;
      state.blockedStrikes = [];
      const muteMinutes = Math.round(this.muteDurationMs / ONE_MINUTE_MS);
      const warnMsg = `[AntiSpam] Nomor tak terdaftar (${senderKey}) memicu flood perintah -> dibisukan diam-diam selama ${muteMinutes} menit.`;
      console.warn(warnMsg);
      this.addLog('warn', warnMsg, { sender: senderKey, muteMinutes });
      return true;
    }
    return false;
  }

  getOrCreateGroupState(groupJid) {
    let state = this.groupStates.get(groupJid);
    if (!state) {
      state = {
        lastCommandAt: 0,
        timestamps10Min: [],
        warnedForCurrentLimit: false
      };
      this.groupStates.set(groupJid, state);
    }
    return state;
  }

  /**
   * Mengevaluasi apakah perintah dari pengirim diizinkan dieksekusi sekarang.
   * Mengembalikan:
   * - { allowed: true, jitterMs } jika lolos
   * - { allowed: false, shouldReply: boolean, replyText: string|null, reason: string } jika ditahan
   */
  checkAccess({
    senderKey,
    fromMe = false,
    isKnown = false,
    isMediaCommand = false,
    isGroup = false,
    groupJid = null,
    nowMs = Date.now()
  }) {
    // Pemilik sendiri bebas memakai perintah tanpa pembatasan anti-spam maupun jeda buatan
    if (fromMe) {
      return { allowed: true, jitterMs: 0 };
    }

    const cleanKey = String(senderKey || 'unknown');
    this.pruneOldEntries(nowMs);
    const state = this.getOrCreateSenderState(cleanKey);

    state.timestamps10Min = state.timestamps10Min.filter((t) => nowMs - t < TEN_MINUTES_MS);
    state.timestampsHour = state.timestampsHour.filter((t) => nowMs - t < ONE_HOUR_MS);

    let groupState = null;
    if (isGroup && groupJid) {
      groupState = this.getOrCreateGroupState(String(groupJid));
      groupState.timestamps10Min = groupState.timestamps10Min.filter(
        (t) => nowMs - t < TEN_MINUTES_MS
      );
    }

    // 1. Jika sedang dalam penalti bisu (flood mute), abaikan diam-diam tanpa membalas apa pun
    if (state.mutedUntil > nowMs) {
      return {
        allowed: false,
        shouldReply: false,
        replyText: null,
        reason: 'flood_muted'
      };
    }

    // 2. Circuit breaker global akun (selalu silent drop agar tidak memperparah lonjakan balasan)
    if (this.globalMinuteTimestamps.length >= this.globalMaxPerMinute) {
      if (nowMs - this.lastCircuitBreakerLogAt > ONE_MINUTE_MS) {
        this.lastCircuitBreakerLogAt = nowMs;
        const msg = `[AntiSpam] Batas global ${this.globalMaxPerMinute} balasan perintah/menit tercapai; menahan sementara balasan non-pemilik.`;
        console.warn(msg);
        this.addLog('warn', msg);
      }
      return {
        allowed: false,
        shouldReply: false,
        replyText: null,
        reason: 'global_minute_limit'
      };
    }

    if (!isKnown) {
      if (this.unknownHourTimestamps.length >= this.unknownGlobalMaxPerHour) {
        if (nowMs - this.lastCircuitBreakerLogAt > ONE_MINUTE_MS) {
          this.lastCircuitBreakerLogAt = nowMs;
          const msg = `[AntiSpam] Batas global ${this.unknownGlobalMaxPerHour} balasan/jam ke nomor tak terdaftar tercapai; mode hemat aktif.`;
          console.warn(msg);
          this.addLog('warn', msg);
        }
        return {
          allowed: false,
          shouldReply: false,
          replyText: null,
          reason: 'unknown_global_hour_limit'
        };
      }

      const alreadySeenUnknown = this.unknownFirstSeenMap.has(cleanKey);
      if (!alreadySeenUnknown && this.unknownFirstSeenMap.size >= this.maxNewUnknownSendersPerHour) {
        if (nowMs - this.lastCircuitBreakerLogAt > ONE_MINUTE_MS) {
          this.lastCircuitBreakerLogAt = nowMs;
          const msg = `[AntiSpam] Batas maksimal ${this.maxNewUnknownSendersPerHour} nomor asing baru/jam tercapai; mengabaikan nomor baru secara diam-diam.`;
          console.warn(msg);
          this.addLog('warn', msg);
        }
        return {
          allowed: false,
          shouldReply: false,
          replyText: null,
          reason: 'new_unknown_senders_limit'
        };
      }
    }

    // 3. Cek cooldown per pengirim
    const requiredCooldownMs = isKnown
      ? this.knownCooldownMs
      : isMediaCommand
      ? this.unknownMediaCooldownMs
      : this.unknownTextCooldownMs;

    const elapsedMs = nowMs - state.lastCommandAt;
    if (state.lastCommandAt > 0 && elapsedMs < requiredCooldownMs) {
      const triggeredMute = this.recordBlockedStrike(state, cleanKey, isKnown, nowMs);
      if (triggeredMute || state.warnedForCurrentLimit) {
        return {
          allowed: false,
          shouldReply: false,
          replyText: null,
          reason: triggeredMute ? 'flood_muted' : 'cooldown_silent'
        };
      }
      state.warnedForCurrentLimit = true;
      const waitSec = Math.max(1, Math.ceil((requiredCooldownMs - elapsedMs) / 1000));
      return {
        allowed: false,
        shouldReply: true,
        replyText: `Tunggu sekitar ${waitSec} detik sebelum kirim perintah lagi ya.`,
        reason: 'cooldown'
      };
    }

    // 4. Cek kuota jendela geser 10 menit
    const max10Min = isKnown ? this.knownMaxPer10Min : this.unknownMaxPer10Min;
    if (state.timestamps10Min.length >= max10Min) {
      const triggeredMute = this.recordBlockedStrike(state, cleanKey, isKnown, nowMs);
      if (triggeredMute || state.warnedForCurrentLimit) {
        return {
          allowed: false,
          shouldReply: false,
          replyText: null,
          reason: triggeredMute ? 'flood_muted' : 'quota_10m_silent'
        };
      }
      state.warnedForCurrentLimit = true;
      return {
        allowed: false,
        shouldReply: true,
        replyText: 'Kamu sudah mencapai batas pemakaian perintah sementara. Coba lagi beberapa menit lagi ya.',
        reason: 'quota_10m'
      };
    }

    // 5. Cek kuota per jam (khusus nomor belum terdaftar)
    if (!isKnown && state.timestampsHour.length >= this.unknownMaxPerHour) {
      const triggeredMute = this.recordBlockedStrike(state, cleanKey, isKnown, nowMs);
      if (triggeredMute || state.warnedForCurrentLimit) {
        return {
          allowed: false,
          shouldReply: false,
          replyText: null,
          reason: triggeredMute ? 'flood_muted' : 'quota_1h_silent'
        };
      }
      state.warnedForCurrentLimit = true;
      return {
        allowed: false,
        shouldReply: true,
        replyText: 'Batas pemakaian perintah per jam sudah penuh. Coba lagi satu jam ke depan ya.',
        reason: 'quota_1h'
      };
    }

    // 5b. Perlindungan khusus grup (cooldown & kuota kolektif seluruh anggota grup)
    if (groupState) {
      const groupElapsed = nowMs - groupState.lastCommandAt;
      if (groupState.lastCommandAt > 0 && groupElapsed < this.groupCooldownMs) {
        if (groupState.warnedForCurrentLimit) {
          return {
            allowed: false,
            shouldReply: false,
            replyText: null,
            reason: 'group_cooldown_silent'
          };
        }
        groupState.warnedForCurrentLimit = true;
        const waitSec = Math.max(1, Math.ceil((this.groupCooldownMs - groupElapsed) / 1000));
        return {
          allowed: false,
          shouldReply: true,
          replyText: `Tunggu ${waitSec} detik dulu ya sebelum kirim perintah berikutnya di grup ini.`,
          reason: 'group_cooldown'
        };
      }

      if (groupState.timestamps10Min.length >= this.groupMaxPer10Min) {
        if (groupState.warnedForCurrentLimit) {
          return {
            allowed: false,
            shouldReply: false,
            replyText: null,
            reason: 'group_quota_silent'
          };
        }
        groupState.warnedForCurrentLimit = true;
        return {
          allowed: false,
          shouldReply: true,
          replyText: 'Batas perintah sementara untuk grup ini sedang penuh. Coba beberapa menit lagi ya.',
          reason: 'group_quota_10m'
        };
      }
    }

    // Lolos semua lapisan! Catat pemakaian & reset flag peringatan
    state.lastCommandAt = nowMs;
    state.timestamps10Min.push(nowMs);
    state.timestampsHour.push(nowMs);
    state.warnedForCurrentLimit = false;
    state.blockedStrikes = [];

    if (groupState) {
      groupState.lastCommandAt = nowMs;
      groupState.timestamps10Min.push(nowMs);
      groupState.warnedForCurrentLimit = false;
    }

    this.globalMinuteTimestamps.push(nowMs);
    if (!isKnown) {
      this.unknownHourTimestamps.push(nowMs);
      if (!this.unknownFirstSeenMap.has(cleanKey)) {
        this.unknownFirstSeenMap.set(cleanKey, nowMs);
      }
    }

    const jitterRange = isKnown ? this.knownJitterRange : this.unknownJitterRange;
    const jitterMs = this.getRandomBetween(jitterRange[0], jitterRange[1]);

    return { allowed: true, jitterMs };
  }

  /**
   * Menjalankan fungsi olah media dengan batas konkurensi maksimal (bawaan 2 paralel).
   */
  async runWithMediaSlot(taskFn) {
    if (this.activeMediaJobs >= this.maxConcurrentMedia) {
      if (this.mediaWaitQueue.length >= this.maxQueuedMedia) {
        const busyErr = new Error('Antrean pemrosesan gambar sedang penuh');
        busyErr.code = 'MEDIA_QUEUE_FULL';
        busyErr.userMessage = 'Antrean olah gambar lagi penuh sebentar. Coba kirim ulang beberapa detik lagi ya.';
        throw busyErr;
      }
      await new Promise((resolve) => this.mediaWaitQueue.push(resolve));
    }

    this.activeMediaJobs++;
    try {
      return await taskFn();
    } finally {
      this.activeMediaJobs = Math.max(0, this.activeMediaJobs - 1);
      const next = this.mediaWaitQueue.shift();
      if (next) next();
    }
  }
}

module.exports = {
  CommandAntiSpamGuard
};
