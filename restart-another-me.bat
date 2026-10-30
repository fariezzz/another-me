@echo off
title Restart Another Me Service
cd /d "C:\Users\ASUS\Documents\Web Projects\another-me"

echo ===================================================
echo   Menghentikan service Another Me yang sedang jalan...
echo ===================================================

:: Cari proses yang mendengarkan port 3000 dan matikan PID-nya
for /f "tokens=5" %%a in ('netstat -ano ^| findstr ":3000" ^| findstr "LISTENING"') do (
    echo Mematikan proses PID: %%a
    taskkill /F /PID %%a >nul 2>&1
)

:: Tunggu 1 detik
timeout /t 1 /nobreak >nul

echo.
echo ===================================================
echo   Menyalakan ulang service Another Me...
echo ===================================================
start "" /b cmd /c "timeout /t 2 /nobreak >nul & start http://localhost:3000"
npm start
