#pragma once
#include <vector>
#include <algorithm>
#include <numeric>

#ifdef _WIN32
#include <windows.h>
class BenchmarkTimer {
public:
    BenchmarkTimer() { QueryPerformanceFrequency(&freq_); }
    void start() { QueryPerformanceCounter(&t0_); }
    double stopUs() {
        LARGE_INTEGER t1;
        QueryPerformanceCounter(&t1);
        return static_cast<double>(t1.QuadPart - t0_.QuadPart) * 1e6
               / static_cast<double>(freq_.QuadPart);
    }
private:
    LARGE_INTEGER t0_, freq_;
};
#else
#include <chrono>
class BenchmarkTimer {
public:
    void start() { t0_ = std::chrono::high_resolution_clock::now(); }
    double stopUs() {
        auto dt = std::chrono::high_resolution_clock::now() - t0_;
        return std::chrono::duration<double, std::micro>(dt).count();
    }
private:
    std::chrono::high_resolution_clock::time_point t0_;
};
#endif
