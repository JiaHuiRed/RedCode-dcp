@echo off
setlocal EnableExtensions EnableDelayedExpansion
chcp 65001 >nul
cd /d "%~dp0"

rem ASCII-only on purpose: cmd byte-counts multibyte batch files wrong and can
rem resume execution mid-line. Chinese rationale lives in AGENTS.md.

set "MODE=%~1"
if "%MODE%"=="" set "MODE=build"
if /i "%MODE%"=="-h" set "MODE=help"
if /i "%MODE%"=="--help" set "MODE=help"
if /i "%MODE%"=="/?" set "MODE=help"
if /i "%MODE%"=="help" goto :usage

echo ==================================================
echo  DCP rebuild - %MODE%
echo  repo %cd%
echo ==================================================

rem ---------------- [1/4] source state ----------------
echo.
echo [1/4] SOURCE
set "AHEAD="
set "BEHIND="
git fetch --quiet 2>nul
for /f "tokens=1,2" %%a in ('git rev-list --left-right --count HEAD...@{u} 2^>nul') do (
    set "AHEAD=%%a"
    set "BEHIND=%%b"
)
if defined AHEAD goto :show_delta
echo   origin compare skipped - offline or no upstream; building current tree
goto :after_delta
:show_delta
echo   ahead %AHEAD% / behind %BEHIND%
if "%BEHIND%"=="0" goto :after_delta
echo   [WARN] behind origin. Run "rebuild.bat pull" first, this build is stale source.
:after_delta
git log -1 --format="  HEAD  %%h  %%s"

rem ---------------- pull mode ----------------
if /i not "%MODE%"=="pull" goto :skip_pull
echo.
echo [pull] checking working tree
git diff --quiet 2>nul
if errorlevel 1 goto :dirty
git diff --cached --quiet 2>nul
if errorlevel 1 goto :dirty
git pull --ff-only
if errorlevel 1 goto :pullfail
set "SCHEMA_CHANGED="
for /f %%a in ('git diff --name-only HEAD@{1} HEAD -- dcp.schema.json') do set "SCHEMA_CHANGED=1"
if not defined SCHEMA_CHANGED goto :skip_pull
echo   [CHECK] dcp.schema.json changed. Verify both trigger tables in dcp.jsonc:
echo           modelMinLimits and modelMaxLimits must be filled as a pair (AGENTS.md).
:skip_pull

rem ---------------- [2/4] build ----------------
echo.
echo [2/4] BUILD  npm run build  (clean + tsup + tsc --emitDeclarationOnly)
call npm run build
if errorlevel 1 goto :buildfail

rem ---------------- [3/4] artifact check ----------------
echo.
echo [3/4] ARTIFACT
if not exist dist\index.js goto :nodist
for %%f in (dist\index.js) do echo   dist\index.js  %%~zf bytes  %%~tf
if not exist dist\index.d.ts echo   [WARN] dist\index.d.ts missing, declaration step did not finish
if not exist dist\tui.d.ts echo   [WARN] dist\tui.d.ts missing, declaration step did not finish
git diff HEAD --quiet 2>nul
if errorlevel 1 echo   [i] uncommitted source edits ARE included in this build
git log -1 --format="  dist built at HEAD  %%h  %%s"

rem ---------------- [4/4] optional checks ----------------
echo.
if /i "%MODE%"=="typecheck" goto :do_typecheck
if /i "%MODE%"=="test" goto :do_test
if /i "%MODE%"=="all" goto :do_all
echo [4/4] SKIPPED typecheck and tests - use "rebuild.bat all" to run them
goto :done

:do_typecheck
echo [4/4] TYPECHECK
call npm run typecheck
if errorlevel 1 goto :typecheckfail
goto :done

:do_test
echo [4/4] TEST
goto :run_test

:do_all
echo [4/4] TYPECHECK + TEST
call npm run typecheck
if errorlevel 1 goto :typecheckfail
:run_test
set "TLOG=%TEMP%\dcp-rebuild-tests.log"
echo   runner: npm test  (node --test). Not "bun test" - see the note at the end.
call npm test > "%TLOG%" 2>&1
if not errorlevel 1 goto :test_pass
echo.
type "%TLOG%"
echo.
echo   [FAIL] npm test reported failures.
goto :testfail
:test_pass
type "%TLOG%"
echo.
echo   tests green.
echo   [i] Why not "bun test": bun 1.3.14 cannot run nested node:test subtests,
echo       so prompts.test.ts "system prompt overrides handle reminder tags safely"
echo       dies with NotImplementedError there. It is a runner gap, not a code bug -
echo       node --test runs 149/149 green.
goto :done

rem ---------------- wrap up ----------------
:done
echo.
echo ==================================================
echo  LAST STEP (required): restart every session using this plugin.
echo  The loader imports dist\index.js dynamically, so live processes
echo  keep the old module until they restart.
set "OCN=0"
for /f %%a in ('tasklist /nh 2^>nul ^| findstr /i /b "opencode bun.exe"') do set /a OCN+=1
if not "%OCN%"=="0" goto :warn_running
echo   No opencode / bun process detected right now.
goto :done2
:warn_running
echo   [WARN] %OCN% opencode / bun process still holds the previous build.
:done2
echo   (heuristic by image name - confirm yourself if opencode runs renamed)
echo ==================================================
endlocal
exit /b 0

:usage
echo.
echo   rebuild.bat            source state + build + artifact check
echo   rebuild.bat pull       git pull --ff-only first (only if tree is clean)
echo   rebuild.bat typecheck  then tsc --noEmit
echo   rebuild.bat test       then the test suite
echo   rebuild.bat all        then typecheck + tests
echo.
echo   pull never stashes or overwrites local edits - it stops and tells you.
echo   Tests use npm test (node runner) and exit 1 on any failure.
echo ==================================================
endlocal
exit /b 0

:dirty
echo   [BLOCKED] uncommitted changes in the working tree.
echo             Commit or checkout them yourself, then retry pull mode.
echo             This script will not stash or overwrite anything.
goto :exit1

:pullfail
echo   [FAIL] git pull failed (diverged or non-fast-forward). Source untouched.
goto :exit1

:buildfail
echo   [FAIL] build failed - dist may be half-written or deleted by clean.
goto :exit_trailer

:nodist
echo   [FAIL] build reported success but dist\index.js is gone.
goto :exit_trailer

:typecheckfail
echo   [FAIL] tsc --noEmit reported errors. dist built, but do not ship it.
goto :exit1

:testfail
echo   [FAIL] the test suite is red.
echo          dist built fine; shipping it anyway is your call.
goto :exit1

:exit_trailer
echo.
echo   No trustworthy dist from this run - do not point sessions at it.
:exit1
endlocal
exit /b 1
