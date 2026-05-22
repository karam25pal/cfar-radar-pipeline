cmake_minimum_required(VERSION 3.20)
project(cfar_backend VERSION 1.0.0 LANGUAGES CXX)

set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_CXX_EXTENSIONS OFF)
set(CMAKE_BUILD_TYPE RelWithDebInfo CACHE STRING "")

add_compile_options(-O3 -Wall -Wextra -ffast-math)

# Find FFTW3 (single precision) — try pkg-config first, then local bundled copy
set(FFTW3_LOCAL_DIR "${CMAKE_SOURCE_DIR}/fftw3")
find_package(PkgConfig QUIET)
if(PkgConfig_FOUND)
    pkg_check_modules(FFTW3 QUIET fftw3f)
endif()

if(NOT FFTW3_FOUND)
    # Fallback: use bundled fftw3 (Windows prebuilt)
    message(STATUS "Using bundled FFTW3 from ${FFTW3_LOCAL_DIR}")
    set(FFTW3_INCLUDE_DIRS "${FFTW3_LOCAL_DIR}/include")
    set(FFTW3_LIBRARIES    "${FFTW3_LOCAL_DIR}/lib/libfftw3f.a")
    set(FFTW3_FOUND TRUE)
endif()

find_package(Threads REQUIRED)
find_package(GTest QUIET)

add_library(cfar_lib STATIC
    src/CFARDetector.cpp
    src/FFTProcessor.cpp
    src/DopplerProcessor.cpp
    src/DataLoader.cpp
)
target_include_directories(cfar_lib PUBLIC include ${FFTW3_INCLUDE_DIRS})
target_link_libraries(cfar_lib PUBLIC ${FFTW3_LIBRARIES} Threads::Threads)

add_executable(cfar_processor src/main.cpp)
target_link_libraries(cfar_processor PRIVATE cfar_lib)
install(TARGETS cfar_processor DESTINATION ${CMAKE_SOURCE_DIR}/../server/bin)

if(GTest_FOUND)
    add_subdirectory(tests)
endif()
add_subdirectory(benchmarks)
