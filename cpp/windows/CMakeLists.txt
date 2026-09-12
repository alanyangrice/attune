cmake_minimum_required(VERSION 3.22.1)

project(attune_windows_vitals LANGUAGES CXX)

set(CMAKE_CXX_STANDARD 20)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_CXX_EXTENSIONS OFF)

set(SMARTSPECTRA_SDK_DIR "$ENV{SMARTSPECTRA_SDK_PATH}")
if (SMARTSPECTRA_SDK_DIR STREQUAL "")
    message(FATAL_ERROR
        "SMARTSPECTRA_SDK_PATH is not set. "
        "Point it at the extracted SmartSpectra Windows SDK directory.")
endif ()

list(APPEND CMAKE_PREFIX_PATH "${SMARTSPECTRA_SDK_DIR}")
find_package(SmartSpectra CONFIG REQUIRED)

add_executable(attune_windows_vitals hello_vitals.cpp)
target_link_libraries(attune_windows_vitals PRIVATE SmartSpectra::SDK)
