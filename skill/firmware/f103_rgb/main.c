/*
 * main.c - STM32F103 RGB LED driver, used as a CONTROLLABLE LIGHT SOURCE
 *          for the LinShang LS125 UV probe / nanoDLA protocol experiment.
 *
 * Wiring (given by the user):
 *   PB14 -> GREEN, PB13 -> BLUE, PB12 -> RED   (common ANODE RGB LED)
 *   => LOW level = LED ON.  All pins idle HIGH (off) after init.
 *
 * Clock: after reset the STM32F1 runs on HSI 8 MHz with SYSCLK = HCLK = 8 MHz.
 *        No PLL / no clock tree setup on purpose.  SysTick (processor clock)
 *        gives exact 1 ms ticks; no interrupts are used.
 *
 * Deliberately does NOT touch PA13/PA14 (SWD) so the debugger stays attached.
 *
 * ---------------------------------------------------------------------------
 * TEST_MODE 1  = SINGLE BLUE PULSE  (used for the max/average record test)
 * ---------------------------------------------------------------------------
 *   after reset:
 *       all OFF for 40 s        <- operator clears the meter's MAX/AVG records
 *       BLUE  ON for 20 s       <- the exposure to be measured
 *       all OFF forever         <- never repeats, so MAX cannot be polluted
 *
 *   The capture is started ~2.5 s after reset and runs 120 s, so the whole
 *   pulse is covered with ~35 s of margin before and ~60 s after.
 *
 * ---------------------------------------------------------------------------
 * TEST_MODE 0  = R/G/B/ALL CYCLE  (spectral response test, already done)
 * ---------------------------------------------------------------------------
 *   2 s ALL OFF
 *   repeat: RED 6 s -> off 4 s -> GREEN 6 s -> off 4 s -> BLUE 6 s -> off 4 s
 *           -> ALL 6 s -> off 12 s          (cycle = 48 s)
 *   Result of that test: the probe responds to BLUE (and ALL) only;
 *   RED and GREEN produce no response at all.
 */

#include <stdint.h>

#define TEST_MODE 1

#define RCC_APB2ENR (*(volatile uint32_t *)0x40021018u)
#define GPIOB_CRH   (*(volatile uint32_t *)0x40010C04u)
#define GPIOB_BSRR  (*(volatile uint32_t *)0x40010C10u)

#define SYSTICK_CTRL (*(volatile uint32_t *)0xE000E010u)
#define SYSTICK_LOAD (*(volatile uint32_t *)0xE000E014u)
#define SYSTICK_VAL  (*(volatile uint32_t *)0xE000E018u)

#define SYSCLK_HZ 8000000u

#define PIN_RED   12u
#define PIN_GREEN 14u
#define PIN_BLUE  13u

#define BIT(n) (1u << (n))

/* --- exact 1 ms busy delay on SysTick (processor clock, no interrupt) --- */
static void delay_ms(uint32_t ms)
{
    SYSTICK_LOAD = (SYSCLK_HZ / 1000u) - 1u;
    SYSTICK_VAL  = 0u;
    SYSTICK_CTRL = 5u;              /* ENABLE=1, CLKSOURCE=processor clock */

    while (ms--) {
        /* reading CTRL clears COUNTFLAG */
        while ((SYSTICK_CTRL & (1u << 16)) == 0u)
            ;
    }

    SYSTICK_CTRL = 0u;
}

/* common anode: OFF = pin HIGH (BSRR low half sets), ON = pin LOW (high half resets) */
static void leds_off(uint32_t pins)
{
    GPIOB_BSRR = pins;
}

static void leds_on(uint32_t pins)
{
    GPIOB_BSRR = pins << 16;
}

static void leds_all_off(void)
{
    leds_off(BIT(PIN_RED) | BIT(PIN_GREEN) | BIT(PIN_BLUE));
}

static void gpio_init(void)
{
    RCC_APB2ENR |= BIT(3);          /* IOPBEN */
    (void)RCC_APB2ENR;

    /* PB12/PB13/PB14: CNF=00 push-pull, MODE=10 output 2 MHz -> nibble 0b0010 */
    GPIOB_CRH = (GPIOB_CRH & ~(0xFFFu << 16)) | (0x222u << 16);

    leds_all_off();
}

int main(void)
{
    gpio_init();

#if TEST_MODE
    /* --- single blue pulse, never repeats --- */
    leds_all_off();
    delay_ms(40000);                /* operator clears MAX/AVG records now */
    leds_on(BIT(PIN_BLUE));
    delay_ms(20000);                /* the exposure */
    leds_all_off();

    for (;;) {
        /* keep the pins actively driven high (off) */
        leds_all_off();
        delay_ms(1000);
    }
#else
    /* --- R/G/B/ALL cycle --- */
    delay_ms(2000);
    for (;;) {
        leds_on(BIT(PIN_RED));
        delay_ms(6000);
        leds_all_off();
        delay_ms(4000);

        leds_on(BIT(PIN_GREEN));
        delay_ms(6000);
        leds_all_off();
        delay_ms(4000);

        leds_on(BIT(PIN_BLUE));
        delay_ms(6000);
        leds_all_off();
        delay_ms(4000);

        leds_on(BIT(PIN_RED) | BIT(PIN_GREEN) | BIT(PIN_BLUE));
        delay_ms(6000);
        leds_all_off();
        delay_ms(12000);
    }
#endif
}
