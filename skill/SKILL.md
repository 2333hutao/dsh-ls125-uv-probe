---
name: ls125-uv-probe
description: Drive a LinShang LS125 UV irradiance meter's UVALED-X3 probe from your own MCU. Contains the fully reverse-engineered 9600 8N1 protocol (28-byte frames, CRC-16/MODBUS, poll + clear commands), a self-contained nanoDLA capture/decode toolchain, and a verified STM32F103 host firmware.
whenToUse: Any work on the LS125 / UVALED-X3 UV probe link — reading irradiance / accumulated energy / average / minimum, writing your own host MCU firmware, clearing the probe's records, or re-verifying the protocol. Also a worked reference case for reverse-engineering an unknown private UART protocol with a logic analyzer.
---

# LS125 紫外辐照计 / UVALED-X3 探头

**一句话**：探头**只需要被 9600 8N1 轮询**，就会每 500 ms 回报一个 28 字节测量帧。
协议已完全逆向，**可以用自制 MCU 完全替代原装表**（已实测：21/21 帧、零 CRC 错、零超时）。

本技能是操作入口；完整规格见工程包里的 `PROTOCOL.md`，方法论与踩坑见 `LESSONS.md`，
原始证据（17 节）见 `nanodla-logic-analyzer/references/case-ls125-uv-meter.md`。

---

## 1. 协议速查

**物理层**：UART **9600 8N1**，空闲高。三根信号：
`D0` = 主机→探头、`D2` = 探头→主机、`D4` = 静态控制线（**可悬空**，与复位/清零无关）。

**主机命令（末尾 2 字节 = CRC-16/MODBUS 小端）**

```
轮询（每 500 ms 必发）  AB 20 60 00 14 00 89 07
清零                    AB 21 20 00 02 00 01 00 3D 8A
```

**探头回帧（28 字节，帧头 `AB 20 60 00 14 00`）**

| 偏移 | 类型 | 含义 | 单位 |
|---|---|---|---|
| 6–9 | float LE | 实时辐照度 | **µW/cm²**（表显 mW/cm² = ÷1000） |
| 10–13 | float LE | 累积能量 | **µJ/cm²**（= ∫辐照度 dt） |
| 14–15 | uint16 LE | 距上次清零的时间 | **×0.1 s** |
| 16–17 | 2B | 恒 0（含义未定，已排除单位/量程） | — |
| 18–21 | float LE | 最小值 | µW/cm² |
| 22–25 | float LE | 平均辐照度 | µW/cm² |
| 26–27 | uint16 LE | **CRC-16/MODBUS**（over 0–25） | — |

**CRC**：poly `0x8005`（反射实现 `0xA001`）、init `0xFFFF`、LSB-first、xorout `0`。

**关键性质**（都实测过）
- 帧内数值**永远是 µW/cm² / µJ/cm²**，不随表上的单位档变化 ⇒ **主机不用管单位设置**。
- **最大值不在帧里** ⇒ 自己从实时流统计（表也是这么做的）。
- **探头只在被轮询时回帧**，且**不需要任何上电握手**。
- 表的开机配置命令（`AB 40 …` 等 9 条）**自制主机一条都不用发**。

**参考实现**：`firmware/f103_probe/main.c`（轮询 + CRC + 四字段解析 + 可选清零）。

---

## 2. 工具链（自包含，无需硬件也能试跑）

```powershell
# 抓取（自动 USB 复位；--stopfile 支持任意时长开放式抓取）
node tools\fx2cap.cjs --rate 250000 --ms 20000 --out captures\now.bin

# 解码：切帧 + 逐字节 uniq + 浮点字段扫描 + 跳变报告
node tools\uv-analyze.cjs captures\now.bin 250000 2 9600

# 反推/验证校验和（穷举 65536 个 CRC-16 多项式）
node tools\checksum-hunt.cjs captures\now.bin 250000 2 9600

# 打印原始电平游程（怀疑解码器时，先手工核对波形）
node tools\runs.cjs captures\now.bin 250000 0
```

包里自带样本（无需硬件）：
`captures\ls125-dark-3s.bin`（1 MHz / 3 s）、`ls125-f103host-20s.bin`（250 kHz / 20 s）、
`ls125-settings-188s.bin`（100 kHz / 188 s，含表的完整配置命令序列）。

**采样率必须 ≥ 波特率 × 10**（9600 用 100–250 kHz 足够；
115200 在 250 kHz 下只有 2.2 采样/位，**解不出来**）。

---

## 3. 硬规则（每条都真实踩过）

1. **原装表必须拔掉**才能接自制主机 —— 否则两个 TX 抢同一根线。
2. **必须共地**；**逻辑分析仪的 GND 一定要接**，否则 8 通道全部悬空读高、什么都看不到。
3. **不要把 5V 接到分析仪任何通道**（输入范围 [−0.5, 5.25] V）。
4. **分析仪打不开（`LIBUSB_ERROR_NOT_SUPPORTED`）时不要去修驱动** ——
   那是 sigrok 内置的 2016 年 libusb 的问题，重装/重启/换口全部无效；
   **用 `tools/fx2cap.cjs` 绕开**。
5. **fx2lafw 没有 STOP 命令** ⇒ 抓取前必须 USB 复位（工具已默认做）；**别 kill 抓取进程**（会丢数据，用 `--stopfile`）。
6. **怀疑解码器之前先看原始游程** —— 基于边沿的解码器会被 1 采样宽的串扰毛刺打断，
   把合法的 8N1 报成乱码。

---

## 4. 复核方式（改结论前必做）

要推翻本文任何结论，必须给出**新的实测证据**（新抓取的字节，或与表显的逐位对照），
不能靠推理。最有力的验证手段是**让仪器自己的显示屏当权威参照**：
把帧内字段值与表显读数做逐位对照（本项目就是靠"三轮、四位小数、无一例外"把量纲钉死的）。
