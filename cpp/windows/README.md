# Windows C++ SmartSpectra camera test

This is the native Windows C++20 camera path for Attune. It requests breathing,
cardio, and face bundles and prints heart rate, breathing rate, HRV RMSSD,
blinking, talking, and a conservative engagement proxy as samples become
available.

Windows support in the SmartSpectra C++ SDK is currently experimental.

## Prerequisites

- Windows 10/11 x64
- Visual Studio 2022 or Build Tools with **Desktop development with C++**
- CMake 3.22.1+
- A Presage SmartSpectra API key
- The extracted SmartSpectra Windows x64 ZIP SDK

Set `SMARTSPECTRA_SDK_PATH` to the extracted SDK directory. Keep its `bin/` and
`share/` directories together.

## Build

Run these commands from an **x64 Native Tools Command Prompt for VS 2022**:

```bat
cd /d C:\path\to\HackRice16\hackrice16\cpp\windows
set "SMARTSPECTRA_SDK_PATH=C:\SmartSpectra"
cmake -S . -B build -G "Visual Studio 17 2022" -A x64
cmake --build build --config Release
```

## Run with the laptop camera

Put the SDK runtime directory on `PATH`, then pass the key without committing
it:

```bat
set "PATH=%SMARTSPECTRA_SDK_PATH%\bin;%PATH%"
set "SMARTSPECTRA_API_KEY=YOUR_KEY"
.\build\Release\attune_windows_vitals.exe
```

You can also pass the key as the first argument:

```bat
.\build\Release\attune_windows_vitals.exe YOUR_KEY
```

The first output may be validation guidance while the camera tunes. Keep your
face and upper chest visible, centered, well lit, and still. The engagement
proxy is not eye tracking or proof of attention; it only indicates whether
face landmarks are available and the latest blink status is not active. Press
`Ctrl+C` to stop.
