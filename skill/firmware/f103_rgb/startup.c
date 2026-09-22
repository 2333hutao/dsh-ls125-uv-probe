/*
 * startup.c - minimal freestanding (-nostdlib) startup for STM32F103 (Cortex-M3).
 *
 * No interrupts are enabled, so only vector index 1 (Reset) must be correct.
 * The table is sized with a GCC range designator, which makes a mis-sized
 * table impossible -- this is deliberate: the hand-written F103 table that
 * had to be exactly 54 entries is a known trap in this project (see AGENTS.md).
 *
 * STM32F103 medium-density: 16 system vectors + 43 peripheral IRQs = 59.
 * We declare 16 + 60 = 76 entries; extra entries beyond what the NVIC drives
 * are harmless.
 */

#include <stdint.h>

extern uint32_t _estack;
extern uint32_t _sidata;
extern uint32_t _sdata;
extern uint32_t _edata;
extern uint32_t _sbss;
extern uint32_t _ebss;

int main(void);

void Reset_Handler(void);
void Default_Handler(void);

__attribute__((section(".isr_vector"), used))
void (*const g_vectors[16 + 60])(void) = {
    [0] = (void (*)(void))&_estack,
    [1] = Reset_Handler,
    [2 ... 16 + 60 - 1] = Default_Handler,
};

void Reset_Handler(void)
{
    uint32_t *src = &_sidata;
    uint32_t *dst = &_sdata;

    while (dst < &_edata)
        *dst++ = *src++;

    for (dst = &_sbss; dst < &_ebss; )
        *dst++ = 0u;

    (void)main();

    for (;;)
        ;
}

void Default_Handler(void)
{
    for (;;)
        ;
}
