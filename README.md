# dsh-ls125-uv-probe

A **DeepSeek Harness skill plugin** for the **林上 LinShang LS125 紫外辐照计** and its
**UVALED-X3** UV probe: the private UART protocol between the meter and the probe,
reverse-engineered end to end, plus the tooling to capture and decode it and a
**verified host firmware** that replaces the original meter.

> 中文说明：[README.zh.md](README.zh.md)

Install it and your agent gains a `ls125-uv-probe` skill — the protocol table, the
commands, the toolchain usage, and the traps that make a working setup look dead.

## What it answers

| Question | Answer |
|---|---|
| Can I read this probe from my own MCU, without the original meter? | **Yes** — verified on an STM32F103: 21/21 frames, zero CRC errors, zero timeouts |
| What is the protocol? | **9600 8N1**, polled every 500 ms, 28-byte replies, **CRC-16/MODBUS** |
| Is there a hidden handshake, challenge, or ID check? | **No** — the poll command is a constant 8-byte string |
| Can I reset the probe's records? | **Yes** — a second command; it clears energy, minimum, and the elapsed-time counter |
| Do I have to send the meter's startup configuration? | **No** — polling alone is enough (verified) |

## Install

```sh
dsh plugin --profile web add dsh-ls125-uv-probe
```

Or straight from this repository:

```sh
dsh plugin --profile web add github:2333hutao/dsh-ls125-uv-probe
```

## Protocol at a glance

```
主机 → 探头  轮询（每 500 ms）  AB 20 60 00 14 00 89 07
             清零             AB 21 20 00 02 00 01 00 3D 8A

探头 → 主机  28 字节帧，帧头 AB 20 60 00 14 00
  偏移  6–9   float LE   实时辐照度          µW/cm²（表显 mW/cm² = ÷1000）
  偏移 10–13  float LE   累积能量            µJ/cm²
  偏移 14–15  uint16 LE  距上次清零的时间     ×0.1 s
  偏移 16–17  2 字节     恒 0（含义未定）
  偏移 18–21  float LE   最小值              µW/cm²
  偏移 22–25  float LE   平均辐照度          µW/cm²
  偏移 26–27  uint16 LE  CRC-16/MODBUS（over 0–25，poly 0xA001 / init 0xFFFF / LSB-first）
```

Frame values are **always** µW/cm² and µJ/cm² regardless of the meter's display
unit setting, so a host never has to track that setting. The **maximum is not in
the frame** — the meter computes it, and so should you.

## What ships in here

```
skill/SKILL.md      the skill body (protocol quick table, commands, toolchain usage, hard rules)
skill/PROTOCOL.md   full specification, command families, reference C implementation
skill/LESSONS.md    transferable methodology + 13 measured pitfalls with their verdicts
skill/AGENTS.md     a takeover briefing for an agent landing in the workspace
skill/tools/        fx2cap.cjs (capture, official libusb + fx2lafw) and four decode/analysis scripts
skill/firmware/     f103_probe (verified host) and f103_rgb (controllable light source)
skill/captures/     a sample capture so the toolchain can be exercised with no hardware
```

The toolchain bypasses a long-standing sigrok problem: every Windows sigrok build
statically links a 2016 `libusb` whose backend dispatch fails on some systems, so
`fx2lafw` reports `LIBUSB_ERROR_NOT_SUPPORTED` while `--scan` still lists the
device. Reinstalling drivers does not help. `fx2cap.cjs` talks to the device with
an official `libusb` instead, and adds what sigrok lacks: no capture duration cap
and a soft trigger.

## Evidence, not assertions

Every claim above was measured, and the repository keeps the measurements: three
rounds of "frame value ↔ meter display" matched to all four decimals, a 65536-polynomial
brute force that found the checksum, a halt test that proved the probe never speaks
unless polled, and four independent experiments that ruled D4 out as a reset line.

## How this was built — AI authorship disclosure

**All of the code, firmware, tooling and documentation in this repository was written by an
AI agent** (DeepSeek Harness), working from measurements taken on real hardware.

The protocol knowledge here was not copied from a datasheet, a vendor document, or a
third-party implementation — it was captured off the wire, cross-checked against the meter's
own display, and every claim is backed by a recorded experiment. Nothing in `skill/` is
asserted without a measurement behind it, and the few open items are labelled as open.

A human operator did the parts an AI cannot: wiring, power, probes, pressing the meter's
own keys, and reporting what its display showed.

Review it as you would any machine-written code before relying on it. The measurement
evidence is all here, so the claims can be re-checked rather than taken on trust.

## License

MIT
