@echo off
setlocal

pushd "%~dp0sparrow-studio\web"
if errorlevel 1 (
  echo Could not find sparrow-studio\web beside this launcher.
  exit /b 1
)

if not exist "node_modules" (
  echo Installing web dependencies...
  call npm ci
  if errorlevel 1 goto failed
)

echo Building sparrow/studio web...
call npm run build
if errorlevel 1 goto failed

echo Starting preview at http://127.0.0.1:4173/
call npm run preview
set "result=%ERRORLEVEL%"
popd
exit /b %result%

:failed
set "result=%ERRORLEVEL%"
echo Build or dependency installation failed.
popd
exit /b %result%
