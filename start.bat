@echo off
REM Serves the Credentials app on http://localhost:8000
cd /d "%~dp0"
echo.
echo === Credentials ===
echo Open http://localhost:8000 in your browser.
echo Press Ctrl+C to stop.
echo.

REM Prefer the official Python launcher "py" (avoids the Microsoft Store stub).
where py >nul 2>nul
if %ERRORLEVEL%==0 (
  py -3 -m http.server 8000
  goto :done
)

REM Fallback: try python.exe but only if it isn't the Store alias.
for /f "delims=" %%P in ('where python 2^>nul') do (
  echo %%P | findstr /i "WindowsApps" >nul
  if errorlevel 1 (
    "%%P" -m http.server 8000
    goto :done
  )
)

echo Could not find a working Python. Install Python 3 from https://www.python.org/downloads/
echo (Make sure to tick "Add Python to PATH" during install.)

:done
echo.
pause
