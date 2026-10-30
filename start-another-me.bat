@echo off
title Another Me - WhatsApp AI Service
cd /d "C:\Users\ASUS\Documents\Web Projects\another-me"

echo ===================================================
echo   Menjalankan Another Me - WhatsApp AI Service...
echo ===================================================
echo.

:: Buka dashboard di browser otomatis setelah 2 detik
start "" /b cmd /c "timeout /t 2 /nobreak >nul & start http://localhost:3000"

:: Jalankan server Node.js
npm start

if %errorlevel% neq 0 (
    echo.
    echo Service terhenti dengan kode error.
    pause
)
