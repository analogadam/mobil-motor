@echo off
rem MobilMotor.exe'yi Windows'un kendi C# derleyicisiyle derler (indirme yok).
cd /d "%~dp0"
if not exist mobilmotor.ico powershell -NoProfile -ExecutionPolicy Bypass -File ikon.ps1
"%WINDIR%\Microsoft.NET\Framework64\v4.0.30319\csc.exe" /nologo /target:winexe /optimize+ /codepage:65001 ^
  /win32icon:mobilmotor.ico /out:..\MobilMotor.exe ^
  /r:System.Windows.Forms.dll /r:System.Drawing.dll MobilMotor.cs
