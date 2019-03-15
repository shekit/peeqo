"use strict";
var Dotstar = (function () {
    function Dotstar(spi, options) {
        if (options === void 0) { options = {}; }
        this.length = options.length || Dotstar.defaultOptions.length;
        var fullBufferLength = Dotstar.startBytesLength + this.length * Dotstar.bytesPerLed + Dotstar.endBytesLength;
        this.ledBuffer = new Buffer(fullBufferLength);
        this.ledBuffer.fill(0);
        this.ledBuffer.fill(255, this.ledBuffer.length - Dotstar.endBytesLength);
        // Create buffer which is subset of the full buffer represetenting only the LEDs
        this.colorBuffer = this.ledBuffer.slice(Dotstar.startBytesLength, -Dotstar.endBytesLength);
        this.clear();
        this.offBuffer = new Buffer(fullBufferLength);
        this.ledBuffer.copy(this.offBuffer);
        this.device = spi;
        this.write(this.offBuffer);
    }
    /**
     * Set every LED in the colorBuffer to the RGBA value.
     */
    Dotstar.prototype.all = function (r, g, b, a) {
        if (a === void 0) { a = 1; }
        var singleLedBuffer = this.convertRgbaToLedBuffer(r, g, b, a);
        for (var led = 0; led < this.length; led++) {
            singleLedBuffer.copy(this.colorBuffer, Dotstar.bytesPerLed * led);
        }
    };
    /**
     * Set every LED in the colorBuffer to black/off.
     */
    Dotstar.prototype.clear = function () {
        this.all(0, 0, 0, 0);
    };
    /**
     * Turn off every LED without having to update the color buffer.
     * This is slightly faster and useful when you want to resume with the previous color.
     */
    Dotstar.prototype.off = function () {
        this.write(this.offBuffer);
    };
    /**
     * Set a specific LED in the colorBuffer to RGBA value.
     */
    Dotstar.prototype.set = function (led, r, g, b, a) {
        if (a === void 0) { a = 1; }
        if (led < 0) {
            throw new Error("led value must be a positive integer. You passed " + led);
        }
        if (led > this.length) {
            throw new Error("led value must not be greater than the maximum length of the led strip. The max length is: " + this.length + ". You passed: " + led);
        }
        var ledBuffer = this.convertRgbaToLedBuffer(r, g, b, a);
        var ledOffset = Dotstar.bytesPerLed * led;
        ledBuffer.copy(this.colorBuffer, ledOffset);
    };
    /**
     * Update DotStar LED strip with current data in led buffer.
     */
    Dotstar.prototype.sync = function () {
        this.write(this.ledBuffer);
    };
    /**
     * Convert RGBA value to Buffer
     */
    Dotstar.prototype.convertRgbaToLedBuffer = function (r, g, b, a) {
        if (a === void 0) { a = 1; }
        var brightnessValue = Math.floor(31 * a) + 224;
        var ledBuffer = new Buffer(Dotstar.bytesPerLed);
        ledBuffer.writeUInt8(brightnessValue, 0);
        ledBuffer.writeUInt8(b, 1);
        ledBuffer.writeUInt8(g, 2);
        ledBuffer.writeUInt8(r, 3);
        return ledBuffer;
    };
    /**
     * Wrapper around device.write which rethrows errors
     */
    Dotstar.prototype.write = function (buffer) {
        this.device.write(buffer, function (error) {
            if (error) {
                throw error;
            }
        });
    };
    Dotstar.defaultOptions = {
        length: 10
    };
    Dotstar.startBytesLength = 4;
    Dotstar.endBytesLength = 4;
    Dotstar.bytesPerLed = 4;
    return Dotstar;
}());
exports.Dotstar = Dotstar;
//# sourceMappingURL=dotstar.js.map