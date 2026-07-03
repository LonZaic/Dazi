@echo off
REM ============================================================
REM start-redis.bat — 一键启动 Redis（Windows 本地版）
REM ============================================================
REM   场景：双击即可启动 Redis 8.8.0
REM   配置：默认端口 6379，最大内存 256mb，LRU 淘汰策略
REM ============================================================

cd /d "%~dp0"
echo [start-redis] 启动 Redis 8.8.0 ...
echo [start-redis] 端口 6379，最大内存 256mb
echo.

redis-server.exe --port 6379 --maxmemory 256mb --maxmemory-policy allkeys-lru

pause
