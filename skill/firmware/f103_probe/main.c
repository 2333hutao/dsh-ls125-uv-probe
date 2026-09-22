/*
 * main.c - STM32F103 acts as the HOST side of the LinShang LS125 probe link,
 *          with NO original meter involved.
 *
 * It sends the fixed 8-byte poll every 500 ms on USART1 and parses the probe's
 * 28-byte reply (CRC-16/MODBUS + three little-endian floats).
 *
 * Wiring:
 *   PA9  USART1_TX  9600 8N1  -> probe's "meter->probe" line  (was LA channel D0)
 *   PA10 USART1_RX  9600 8N1  <- probe's "probe->meter" line  (was LA channel D2)
 *   PA2  USART2_TX 115200 8N1 -> debug ASCII (optional: clip to a spare LA channel)
 *   GND <-> probe GND,  5V -> probe 5V
 *   probe's 3rd signal (was LA channel D4, always low) is LEFT FLOATING on purpose,
 *   to find out whether the probe actually needs it.
 *
 * The original meter MUST be unplugged, else its TX fights ours on the same wire.
 *
 * No interrupts are used at all: RX is polled (9600 baud = 1.04 ms/byte, plenty).
 * PB12/13/14 (the RGB light source used earlier) are kept OFF.
 */

#include <stdint.h>

#define RCC_APB2ENR (*(volatile uint32_t *)0x40021018u)
#define RCC_APB1ENR (*(volatile uint32_t *)0x4002101Cu)

#define GPIOA_CRL   (*(volatile uint32_t *)0x40010800u)
#define GPIOA_CRH   (*(volatile uint32_t *)0x40010804u)
#define GPIOB_CRH   (*(volatile uint32_t *)0x40010C04u)
#define GPIOB_BSRR  (*(volatile uint32_t *)0x40010C10u)

#define USART1_SR   (*(volatile uint32_t *)0x40013800u)
#define USART1_DR   (*(volatile uint32_t *)0x40013804u)
#define USART1_BRR  (*(volatile uint32_t *)0x40013808u)
#define USART1_CR1  (*(volatile uint32_t *)0x4001380Cu)

#define USART2_SR   (*(volatile uint32_t *)0x40004400u)
#define USART2_DR   (*(volatile uint32_t *)0x40004404u)
#define USART2_BRR  (*(volatile uint32_t *)0x40004408u)
#define USART2_CR1  (*(volatile uint32_t *)0x4000440Cu)

#define SYSTICK_CTRL (*(volatile uint32_t *)0xE000E010u)
#define SYSTICK_LOAD (*(volatile uint32_t *)0xE000E014u)
#define SYSTICK_VAL  (*(volatile uint32_t *)0xE000E018u)

#define SYSCLK_HZ 8000000u
#define BIT(n) (1u << (n))

#define PIN_RED   12u
#define PIN_GREEN 14u
#define PIN_BLUE  13u

/* ---------------- millisecond time base (polled, no interrupt) ---------------- */
static volatile uint32_t g_ms = 0u;

static void systick_start(void)
{
    SYSTICK_LOAD = (SYSCLK_HZ / 1000u) - 1u;
    SYSTICK_VAL  = 0u;
    SYSTICK_CTRL = 5u;              /* ENABLE=1, CLKSOURCE=processor clock */
}

static inline void systick_tick(void)
{
    if (SYSTICK_CTRL & (1u << 16))  /* reading CTRL clears COUNTFLAG */
        g_ms++;
}

/* ---------------- UART ---------------- */
static void uart_init(void)
{
    RCC_APB2ENR |= BIT(2) | BIT(0);     /* IOPAEN, AFIOEN */
    RCC_APB2ENR |= BIT(14);             /* USART1EN */
    RCC_APB1ENR |= BIT(17);             /* USART2EN */
    (void)RCC_APB2ENR;
    (void)RCC_APB1ENR;

    /* PA9 = AF push-pull 50 MHz (0xB), PA10 = input floating (0x4) */
    GPIOA_CRH = (GPIOA_CRH & ~(0xFFu << 4)) | (0x4Bu << 4);

    /* PA2 = AF push-pull 50 MHz (USART2_TX) */
    GPIOA_CRL = (GPIOA_CRL & ~(0xFu << 8)) | (0xBu << 8);

    USART1_BRR = 0x341u;                /* 9600   @ 8 MHz  (USARTDIV = 8e6/(16*9600)  = 52.08) */
    USART1_CR1 = BIT(13) | BIT(3) | BIT(2);   /* UE | TE | RE */

    /* Debug UART kept at 9600 on purpose: at the 250 kHz LA sample rate a
     * 115200 signal is only ~2.2 samples/bit and cannot be decoded reliably,
     * while 9600 gives ~26 samples/bit. */
    USART2_BRR = 0x341u;                /* 9600   @ 8 MHz */
    USART2_CR1 = BIT(13) | BIT(3);            /* UE | TE */
}

static void u1_putc(uint8_t c)
{
    while (!(USART1_SR & BIT(7))) systick_tick();   /* TXE */
    USART1_DR = c;
}

static int u1_getc(void)                /* -1 if nothing */
{
    if (USART1_SR & BIT(5))             /* RXNE */
        return (int)(USART1_DR & 0xFFu);
    return -1;
}

static void u2_putc(uint8_t c)
{
    while (!(USART2_SR & BIT(7))) systick_tick();
    USART2_DR = c;
}

static void u2_puts(const char *s)
{
    while (*s) u2_putc((uint8_t)*s++);
}

static void u2_u32(uint32_t v)
{
    char b[11];
    int  i = 0;
    if (v == 0u) { u2_putc('0'); return; }
    while (v && i < 11) { b[i++] = (char)('0' + (v % 10u)); v /= 10u; }
    while (i--) u2_putc((uint8_t)b[i]);
}

static void u2_fixed(float v, int decimals)
{
    uint32_t mul = 1u, div, ip, fp;
    int i, neg = 0;

    if (v != v) { u2_puts("nan"); return; }        /* NaN */
    if (v < 0.0f) { neg = 1; v = -v; }
    for (i = 0; i < decimals; i++) mul *= 10u;

    ip = (uint32_t)v;
    fp = (uint32_t)((v - (float)ip) * (float)mul + 0.5f);
    if (fp >= mul) { ip += 1u; fp -= mul; }

    if (neg) u2_putc('-');
    u2_u32(ip);
    if (decimals == 0) return;
    u2_putc('.');
    div = mul / 10u;
    for (i = 0; i < decimals; i++) { u2_putc((uint8_t)('0' + (fp / div) % 10u)); div /= 10u; }
}

/* ---------------- LS125 protocol ---------------- */
static uint16_t crc16_modbus(const uint8_t *d, uint32_t n)
{
    uint16_t crc = 0xFFFFu;
    uint32_t i;
    int k;
    for (i = 0; i < n; i++) {
        crc ^= d[i];
        for (k = 0; k < 8; k++)
            crc = (crc & 1u) ? (uint16_t)((crc >> 1) ^ 0xA001u) : (uint16_t)(crc >> 1);
    }
    return crc;
}

static float f32le(const uint8_t *p)
{
    union { uint32_t u; float f; } v;
    v.u = (uint32_t)p[0] | ((uint32_t)p[1] << 8) | ((uint32_t)p[2] << 16) | ((uint32_t)p[3] << 24);
    return v.f;
}

/* the meter's poll command: AB 20 60 00 14 00 + CRC-16/MODBUS(0x0789) little-endian */
static const uint8_t g_poll[8] = { 0xAB, 0x20, 0x60, 0x00, 0x14, 0x00, 0x89, 0x07 };

/* The meter's CLEAR command: sent right after a poll when its DEL key is pressed.
 * AB 21 20 00 02 00 01 00 + CRC-16/MODBUS(0x8A3D) little-endian.
 * Measured effect: resets the probe's accumulated energy (offset 10..13) and its
 * minimum (offset 18..21, which is reloaded with the current reading). */
static const uint8_t g_clear[10] = { 0xAB, 0x21, 0x20, 0x00, 0x02, 0x00, 0x01, 0x00, 0x3D, 0x8A };

/* fire the CLEAR command once after this many polls, to verify it (0 = never) */
#define CLEAR_AT_POLL 0

/* 1 = keep the BLUE led lit while polling, so the probe's "minimum" record can
 *     never be 0 (used to identify the always-zero bytes 16..21 in the frame). */
#define HOLD_BLUE_LED 0

static void leds_init(void)
{
    RCC_APB2ENR |= BIT(3);              /* IOPBEN */
    (void)RCC_APB2ENR;
    GPIOB_CRH = (GPIOB_CRH & ~(0xFFFu << 16)) | (0x222u << 16);
    GPIOB_BSRR = BIT(PIN_RED) | BIT(PIN_GREEN) | BIT(PIN_BLUE);   /* all HIGH = off */
#if HOLD_BLUE_LED
    GPIOB_BSRR = BIT(PIN_BLUE) << 16;                             /* low = ON */
#endif
}

int main(void)
{
    uint8_t  buf[64];
    uint32_t polls = 0, replies = 0, crcbad = 0, empty = 0, shortf = 0;
    uint32_t next = 0, last_status = 0;
    int i, n;

    leds_init();
    systick_start();
    uart_init();

    u2_puts("\r\n=== f103_probe: polling LS125 probe, 9600 8N1 ===\r\n");

    for (;;) {
        /* ---- wait for the next 500 ms slot ---- */
        while ((int32_t)(g_ms - next) < 0)
            systick_tick();
        next += 500u;

        for (i = 0; i < 8; i++)
            u1_putc(g_poll[i]);
        polls++;

        if (CLEAR_AT_POLL && polls == (uint32_t)CLEAR_AT_POLL) {
            u2_puts("-- sending CLEAR command --\r\n");
            for (i = 0; i < 10; i++)
                u1_putc(g_clear[i]);
        }

        /* ---- collect up to 28 bytes, at most 150 ms ---- */
        n = 0;
        {
            uint32_t t0 = g_ms;
            while (n < 28 && (g_ms - t0) < 150u) {
                int c = u1_getc();
                if (c >= 0) buf[n++] = (uint8_t)c;
                systick_tick();
            }
        }

        if (n == 0) {
            empty++;
        } else if (n >= 28 && buf[0] == 0xAB && buf[1] == 0x20 && buf[2] == 0x60 &&
                   buf[3] == 0x00 && buf[4] == 0x14 && buf[5] == 0x00) {
            uint16_t crc = crc16_modbus(buf, 26);
            if (buf[26] == (uint8_t)(crc & 0xFFu) && buf[27] == (uint8_t)(crc >> 8)) {
                replies++;
                u2_puts("I="); u2_fixed(f32le(&buf[6]),  3);
                u2_puts(" E="); u2_fixed(f32le(&buf[10]), 1);
                u2_puts(" A="); u2_fixed(f32le(&buf[22]), 3);
                u2_puts(" M="); u2_fixed(f32le(&buf[18]), 3);
                u2_puts(" cnt="); u2_u32((uint32_t)buf[14] | ((uint32_t)buf[15] << 8));
                u2_puts("\r\n");
            } else {
                crcbad++;
                u2_puts("BADCRC\r\n");
            }
        } else {
            shortf++;
            u2_puts("SHORT n="); u2_u32((uint32_t)n); u2_puts("\r\n");
        }

        /* ---- status line every 5 s ---- */
        if ((g_ms - last_status) >= 5000u) {
            last_status = g_ms;
            u2_puts("-- t=");   u2_u32(g_ms / 1000u);
            u2_puts("s poll="); u2_u32(polls);
            u2_puts(" ok=");    u2_u32(replies);
            u2_puts(" crc=");   u2_u32(crcbad);
            u2_puts(" short="); u2_u32(shortf);
            u2_puts(" none=");  u2_u32(empty);
            u2_puts("\r\n");
        }
    }
}
