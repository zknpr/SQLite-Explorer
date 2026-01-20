@echo off
REM =============================================================================
REM SQLite Explorer - Install Script (Windows)
REM =============================================================================
REM This script builds and installs the SQLite Explorer extension to VS Code.
REM
REM Usage:
REM   install.bat          - Build and install
REM   install.bat --clean  - Clean, build, and install
REM   install.bat --skip-build  - Install existing .vsix without rebuilding
REM =============================================================================

setlocal enabledelayedexpansion

cd /d "%~dp0"

REM Get version from package.json
for /f "tokens=*" %%i in ('node -p "require('./package.json').version"') do set EXT_VERSION=%%i
set EXT_NAME=sqlite-explorer
set VSIX_FILE=%EXT_NAME%-%EXT_VERSION%.vsix

echo =================================
echo   SQLite Explorer Installer
echo   Version: %EXT_VERSION%
echo =================================
echo.

REM Parse arguments
set CLEAN=false
set SKIP_BUILD=false
:parse_args
if "%~1"=="" goto end_parse
if "%~1"=="--clean" set CLEAN=true
if "%~1"=="--skip-build" set SKIP_BUILD=true
if "%~1"=="--help" goto show_help
if "%~1"=="-h" goto show_help
shift
goto parse_args
:end_parse

REM Check for VS Code
where code >nul 2>&1
if %errorlevel% equ 0 (
    set VSCODE_CMD=code
    goto found_vscode
)
where code-insiders >nul 2>&1
if %errorlevel% equ 0 (
    set VSCODE_CMD=code-insiders
    goto found_vscode
)
echo Error: VS Code CLI not found
echo Make sure VS Code is installed and 'code' is in your PATH
exit /b 1

:found_vscode
echo Using: %VSCODE_CMD%

REM Clean if requested
if "%CLEAN%"=="true" (
    echo.
    echo Cleaning build artifacts...
    if exist out rmdir /s /q out
    if exist assets rmdir /s /q assets
    del /q *.vsix 2>nul
    echo Clean complete
)

REM Build unless skipped
if "%SKIP_BUILD%"=="false" (
    echo.
    echo Building extension...
    call node scripts/build.mjs
    if %errorlevel% neq 0 (
        echo Build failed!
        exit /b 1
    )
    echo Build complete

    echo.
    echo Packaging extension...
    call npx vsce package --skip-license --out "%VSIX_FILE%"
    if %errorlevel% neq 0 (
        echo Packaging failed!
        exit /b 1
    )
    echo Package complete: %VSIX_FILE%
) else (
    if not exist "%VSIX_FILE%" (
        echo Error: %VSIX_FILE% not found. Run without --skip-build first.
        exit /b 1
    )
    echo Using existing package: %VSIX_FILE%
)

REM Install
echo.
echo Installing extension to VS Code...
%VSCODE_CMD% --install-extension "%VSIX_FILE%" --force

echo.
echo =================================
echo   Installation Complete!
echo =================================
echo.
echo Reload VS Code to activate the extension:
echo   Ctrl+Shift+P then Developer: Reload Window
echo.
exit /b 0

:show_help
echo Usage: install.bat [OPTIONS]
echo.
echo Options:
echo   --clean       Clean build artifacts before building
echo   --skip-build  Skip build step, install existing .vsix
echo   --help, -h    Show this help message
exit /b 0
