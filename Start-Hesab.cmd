@echo off
setlocal
pushd "%~dp0" || exit /b 1
echo Hesab local preview: http://127.0.0.1:5501/
echo Keep this window open while using the app. Press Ctrl+C to stop.
python -m http.server 5501 --bind 127.0.0.1
if errorlevel 1 pause
popd
