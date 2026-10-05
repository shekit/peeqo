#!/usr/bin/env python3
"""Peeqo's hardware helper, run by the robot service (src/hardware/link.ts): the servo board (a PCA9685 on I2C), the
LED ring (APA102 "DotStar" LEDs on SPI) and the buttons (GPIO). It only does what it is told; every decision about
where the servos may go is made (and checked) by the service.

Commands, one per line on stdin:

  S <us> <us> <us> ...   pulse widths in microseconds for channels 0, 1, 2, ...; 0 turns a channel off (limp)
  L <hex>                an LED frame: 4 bytes per LED (0xE0 | brightness, blue, green, red), as hex
  B <pin> <0|1>          (fake mode only) pretend a button was pressed or released

Events, one JSON object per line on stdout:

  {"type": "ready", "servos": true, "leds": true, "buttons": [4, 16, 17, 23], "fake": false}
  {"type": "button", "pin": 16, "pressed": true}
  {"type": "error", "message": "..."}

The PCA9685 is set up exactly as the 2019 software did it (the pca9685 npm package): 50 Hz from the 25 MHz clock
(prescale 121), single-byte register writes, and a pulse of `us` microseconds ends at step round(us / 4.8828125) - 1.
So a pulse means the same here as it did in 2019. The APA102 frame is the 2019 dotstar.js one: four zero bytes, the
LEDs, four 0xFF bytes, sent at 4 MHz.
"""
import argparse
import json
import sys
import threading
import time

# PCA9685 registers and values, as in the pca9685 npm package used in 2019.
MODE1, MODE2, PRESCALE = 0x00, 0x01, 0xFE
MODE1_DEFAULT, MODE2_DEFAULT = 0x01, 0x04
SLEEP, RESTART = 0x10, 0x80
CHANNEL0_ON_L = 0x06
ALL_OFF_H = 0xFD
FULL_ON_OR_OFF = 0x10
OSCILLATOR_HZ, STEPS, FREQUENCY = 25_000_000, 4096, 50
STEP_US = 1_000_000 / FREQUENCY / STEPS  # 4.8828125 µs
MIN_US, MAX_US = 500, 2500  # a last guard: no hobby servo is driven outside this

out_lock = threading.Lock()


def send(message):
    with out_lock:
        sys.stdout.write(json.dumps(message) + "\n")
        sys.stdout.flush()


def js_round(x):
    """Math.round, as the 2019 driver used (halves round up)."""
    return int(x + 0.5) if x >= 0 else -int(-x + 0.5)


def pulse_steps(us):
    """The off step for a pulse of `us` microseconds (the pulse starts at step 0), or None for off."""
    if us <= 0:
        return None
    return max(0, min(STEPS - 1, js_round(min(MAX_US, max(MIN_US, us)) / STEP_US) - 1))


class Servos:
    def __init__(self, bus_number, address):
        from smbus2 import SMBus

        self.bus = SMBus(bus_number)
        self.address = address
        self.last = {}
        write = self.write
        write(MODE1, MODE1_DEFAULT)
        write(MODE2, MODE2_DEFAULT)
        write(ALL_OFF_H, FULL_ON_OR_OFF)  # all channels off until told otherwise
        old = self.bus.read_byte_data(address, MODE1)
        write(MODE1, (old & ~RESTART) | SLEEP)
        write(PRESCALE, js_round(OSCILLATOR_HZ / (STEPS * FREQUENCY)) - 1)
        write(MODE1, old)
        time.sleep(0.01)
        write(MODE1, old | RESTART)

    def write(self, register, value):
        self.bus.write_byte_data(self.address, register, value & 0xFF)

    def set(self, channel, us):
        steps = pulse_steps(us)
        if self.last.get(channel) == steps:
            return
        self.last[channel] = steps
        base = CHANNEL0_ON_L + 4 * channel
        if steps is None:
            self.write(base + 3, FULL_ON_OR_OFF)
            return
        self.write(base, 0)
        self.write(base + 1, 0)
        self.write(base + 2, steps & 0xFF)
        self.write(base + 3, (steps >> 8) & 0x0F)


class Leds:
    def __init__(self, bus, device, speed_hz):
        import spidev

        self.spi = spidev.SpiDev()
        self.spi.open(bus, device)
        self.spi.mode = 0
        self.spi.max_speed_hz = speed_hz

    def show(self, frame):
        self.spi.writebytes2(bytes(4) + frame + b"\xff" * 4)


def watch_buttons(pins, active_high):
    from gpiozero import Button

    buttons = []
    for pin in pins:
        # As in 2019: pressed reads high. pull_up=False keeps the pin pulled low when not pressed.
        button = Button(pin, pull_up=not active_high, bounce_time=0.03)
        button.when_pressed = lambda b=pin: send({"type": "button", "pin": b, "pressed": True})
        button.when_released = lambda b=pin: send({"type": "button", "pin": b, "pressed": False})
        buttons.append(button)
    return buttons


def main():
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--fake", action="store_true", help="no hardware: accept commands and log them (for development)")
    parser.add_argument("--i2c-bus", type=int, default=1)
    parser.add_argument("--address", type=lambda v: int(v, 0), default=0x40)
    parser.add_argument("--spi", default="0.0", help="SPI bus.device for the LED ring")
    parser.add_argument("--spi-hz", type=int, default=4_000_000)
    parser.add_argument("--buttons", default="4,16,17,23")
    parser.add_argument("--active-low", action="store_true", help="buttons read low when pressed")
    args = parser.parse_args()
    pins = [int(p) for p in args.buttons.split(",") if p.strip()]

    servos = leds = None
    keep = []
    if not args.fake:
        try:
            servos = Servos(args.i2c_bus, args.address)
        except Exception as error:  # noqa: BLE001 - reported to the service, which decides what to do
            send({"type": "error", "message": f"servo board: {error}"})
        try:
            bus, device = (int(v) for v in args.spi.split("."))
            leds = Leds(bus, device, args.spi_hz)
        except Exception as error:  # noqa: BLE001
            send({"type": "error", "message": f"LED ring: {error}"})
        try:
            keep = watch_buttons(pins, not args.active_low)
        except Exception as error:  # noqa: BLE001
            send({"type": "error", "message": f"buttons: {error}"})
            pins = []
    send({"type": "ready", "servos": args.fake or servos is not None, "leds": args.fake or leds is not None, "buttons": pins, "fake": args.fake})

    for line in sys.stdin:
        parts = line.split()
        if not parts:
            continue
        try:
            if parts[0] == "S":
                for channel, value in enumerate(parts[1:17]):
                    if servos:
                        servos.set(channel, float(value))
            elif parts[0] == "L" and len(parts) > 1:
                frame = bytes.fromhex(parts[1])
                if leds:
                    leds.show(frame)
            elif parts[0] == "B" and args.fake and len(parts) == 3:
                send({"type": "button", "pin": int(parts[1]), "pressed": parts[2] == "1"})
        except Exception as error:  # noqa: BLE001
            send({"type": "error", "message": f"{parts[0]}: {error}"})
    del keep  # stdin closed: the service has gone. The servos hold where they are (going limp could drop the head).


if __name__ == "__main__":
    main()
