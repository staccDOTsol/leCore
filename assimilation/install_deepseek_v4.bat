@echo off
REM HRR-attach leCore onto DeepSeek-V4 Flash. Does NOT call GDNRuntime.
REM   install_deepseek_v4.bat MODEL_DIR OUT_DIR
REM Qwen stays on install.bat.
setlocal
set "GALVATRON_CWD=%CD%"
cd /d "%~dp0\.."
set PYTHONHASHSEED=0
set "VPY=assimilation\.venv\Scripts\python.exe"
if not exist "%VPY%" set "VPY=python"
if "%~2"=="" (
  echo usage: %~nx0 MODEL_DIR OUT_DIR [--doc FILE] [--registers N]
  exit /b 1
)
echo   DeepSeek-V4 HRR-attach  %~1  -^>  %~2
"%VPY%" assimilation\install_deepseek_v4.py %*
