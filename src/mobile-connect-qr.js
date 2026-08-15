'use strict';

/*
 * Terminal QR renderer adapted from Project Nayuki's QR Code generator.
 * Source: https://github.com/nayuki/QR-Code-generator
 * Copyright (c) Project Nayuki. (MIT License)
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:
 * The above copyright notice and this permission notice shall be included in
 * all copies or substantial portions of the Software.
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN
 * THE SOFTWARE.
 *
 * This small port keeps byte-mode encoding for pairing URLs and QR versions
 * 1-10. Pairing URLs fit comfortably within version 10 at medium ECC.
 */

const ECC_CODEWORDS_PER_BLOCK = [
  [-1, 7, 10, 15, 20, 26, 18, 20, 24, 30, 18],
  [-1, 10, 16, 26, 18, 24, 16, 18, 22, 22, 26],
  [-1, 13, 22, 18, 26, 18, 24, 18, 22, 20, 24],
  [-1, 17, 28, 22, 16, 22, 28, 26, 26, 24, 28],
];
const NUM_ERROR_CORRECTION_BLOCKS = [
  [-1, 1, 1, 1, 1, 1, 2, 2, 2, 2, 4],
  [-1, 1, 1, 1, 2, 2, 4, 4, 4, 5, 5],
  [-1, 1, 1, 2, 2, 4, 4, 6, 6, 8, 8],
  [-1, 1, 1, 2, 4, 4, 4, 5, 6, 8, 8],
];

const MEDIUM_ECC = Object.freeze({ ordinal: 1, formatBits: 0 });

function assert(condition, message = 'QR assertion failed') {
  if (!condition) throw new Error(message);
}

function getBit(value, index) {
  return ((value >>> index) & 1) !== 0;
}

function appendBits(value, length, bits) {
  if (length < 0 || length > 31 || value >>> length !== 0) {
    throw new RangeError('QR bit value out of range');
  }
  for (let index = length - 1; index >= 0; index -= 1) bits.push((value >>> index) & 1);
}

class QrCode {
  constructor(version, ecc, dataCodewords, mask = -1) {
    if (version < 1 || version > 10) throw new RangeError('QR version out of range');
    if (mask < -1 || mask > 7) throw new RangeError('QR mask out of range');
    this.version = version;
    this.errorCorrectionLevel = ecc;
    this.size = version * 4 + 17;
    this.modules = Array.from({ length: this.size }, () => Array(this.size).fill(false));
    this.isFunction = Array.from({ length: this.size }, () => Array(this.size).fill(false));

    this.drawFunctionPatterns();
    this.drawCodewords(this.addEccAndInterleave(dataCodewords));
    if (mask === -1) {
      let minPenalty = Infinity;
      for (let candidate = 0; candidate < 8; candidate += 1) {
        this.applyMask(candidate);
        this.drawFormatBits(candidate);
        const penalty = this.getPenaltyScore();
        if (penalty < minPenalty) {
          mask = candidate;
          minPenalty = penalty;
        }
        this.applyMask(candidate);
      }
    }
    this.mask = mask;
    this.applyMask(mask);
    this.drawFormatBits(mask);
    this.isFunction = null;
  }

  static encodeText(text, ecc = MEDIUM_ECC) {
    return QrCode.encodeBinary(Buffer.from(String(text), 'utf8'), ecc);
  }

  static encodeBinary(data, ecc = MEDIUM_ECC) {
    const bytes = Buffer.from(data);
    let version = 0;
    let usedBits = 0;
    for (let candidate = 1; candidate <= 10; candidate += 1) {
      const countBits = candidate < 10 ? 8 : 16;
      if (bytes.length >= (1 << countBits)) throw new RangeError('Pairing URL is too long for QR encoding');
      const capacity = QrCode.getNumDataCodewords(candidate, ecc) * 8;
      const needed = 4 + countBits + bytes.length * 8;
      if (needed <= capacity) {
        version = candidate;
        usedBits = needed;
        break;
      }
    }
    if (!version) throw new RangeError('Pairing URL is too long for QR version 10');

    const countBits = version < 10 ? 8 : 16;
    const bits = [];
    appendBits(0x4, 4, bits); // byte mode
    appendBits(bytes.length, countBits, bits);
    for (const byte of bytes) appendBits(byte, 8, bits);

    const capacity = QrCode.getNumDataCodewords(version, ecc) * 8;
    appendBits(0, Math.min(4, capacity - bits.length), bits);
    appendBits(0, (8 - (bits.length % 8)) % 8, bits);
    for (let pad = 0xec; bits.length < capacity; pad ^= 0xec ^ 0x11) appendBits(pad, 8, bits);
    assert(bits.length === capacity);

    const codewords = Array(capacity / 8).fill(0);
    bits.forEach((bit, index) => {
      codewords[index >>> 3] |= bit << (7 - (index & 7));
    });
    assert(usedBits <= capacity);
    return new QrCode(version, ecc, codewords, -1);
  }

  getModule(x, y) {
    return 0 <= x && x < this.size && 0 <= y && y < this.size && this.modules[y][x];
  }

  drawFunctionPatterns() {
    for (let index = 0; index < this.size; index += 1) {
      this.setFunctionModule(6, index, index % 2 === 0);
      this.setFunctionModule(index, 6, index % 2 === 0);
    }
    this.drawFinderPattern(3, 3);
    this.drawFinderPattern(this.size - 4, 3);
    this.drawFinderPattern(3, this.size - 4);
    const positions = this.getAlignmentPatternPositions();
    for (let i = 0; i < positions.length; i += 1) {
      for (let j = 0; j < positions.length; j += 1) {
        if (!((i === 0 && j === 0) || (i === 0 && j === positions.length - 1) || (i === positions.length - 1 && j === 0))) {
          this.drawAlignmentPattern(positions[i], positions[j]);
        }
      }
    }
    this.drawFormatBits(0);
    this.drawVersion();
  }

  drawFormatBits(mask) {
    const data = (this.errorCorrectionLevel.formatBits << 3) | mask;
    let remainder = data;
    for (let index = 0; index < 10; index += 1) {
      remainder = (remainder << 1) ^ ((remainder >>> 9) * 0x537);
    }
    const bits = ((data << 10) | remainder) ^ 0x5412;
    for (let index = 0; index <= 5; index += 1) this.setFunctionModule(8, index, getBit(bits, index));
    this.setFunctionModule(8, 7, getBit(bits, 6));
    this.setFunctionModule(8, 8, getBit(bits, 7));
    this.setFunctionModule(7, 8, getBit(bits, 8));
    for (let index = 9; index < 15; index += 1) this.setFunctionModule(14 - index, 8, getBit(bits, index));
    for (let index = 0; index < 8; index += 1) this.setFunctionModule(this.size - 1 - index, 8, getBit(bits, index));
    for (let index = 8; index < 15; index += 1) this.setFunctionModule(8, this.size - 15 + index, getBit(bits, index));
    this.setFunctionModule(8, this.size - 8, true);
  }

  drawVersion() {
    if (this.version < 7) return;
    let remainder = this.version;
    for (let index = 0; index < 12; index += 1) {
      remainder = (remainder << 1) ^ ((remainder >>> 11) * 0x1f25);
    }
    const bits = (this.version << 12) | remainder;
    for (let index = 0; index < 18; index += 1) {
      const color = getBit(bits, index);
      const a = this.size - 11 + (index % 3);
      const b = Math.floor(index / 3);
      this.setFunctionModule(a, b, color);
      this.setFunctionModule(b, a, color);
    }
  }

  drawFinderPattern(x, y) {
    for (let dy = -4; dy <= 4; dy += 1) {
      for (let dx = -4; dx <= 4; dx += 1) {
        const distance = Math.max(Math.abs(dx), Math.abs(dy));
        const xx = x + dx;
        const yy = y + dy;
        if (0 <= xx && xx < this.size && 0 <= yy && yy < this.size) {
          this.setFunctionModule(xx, yy, distance !== 2 && distance !== 4);
        }
      }
    }
  }

  drawAlignmentPattern(x, y) {
    for (let dy = -2; dy <= 2; dy += 1) {
      for (let dx = -2; dx <= 2; dx += 1) {
        this.setFunctionModule(x + dx, y + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1);
      }
    }
  }

  setFunctionModule(x, y, dark) {
    this.modules[y][x] = Boolean(dark);
    this.isFunction[y][x] = true;
  }

  addEccAndInterleave(data) {
    const eccWords = ECC_CODEWORDS_PER_BLOCK[this.errorCorrectionLevel.ordinal][this.version];
    const blocksCount = NUM_ERROR_CORRECTION_BLOCKS[this.errorCorrectionLevel.ordinal][this.version];
    const rawCodewords = Math.floor(QrCode.getNumRawDataModules(this.version) / 8);
    const shortBlocks = blocksCount - (rawCodewords % blocksCount);
    const shortBlockLength = Math.floor(rawCodewords / blocksCount);
    const divisor = reedSolomonComputeDivisor(eccWords);
    const blocks = [];
    let offset = 0;
    for (let index = 0; index < blocksCount; index += 1) {
      const dataLength = shortBlockLength - eccWords + (index < shortBlocks ? 0 : 1);
      const blockData = data.slice(offset, offset + dataLength);
      offset += dataLength;
      const ecc = reedSolomonComputeRemainder(blockData, divisor);
      if (index < shortBlocks) blockData.push(0);
      blocks.push(blockData.concat(ecc));
    }
    const result = [];
    for (let index = 0; index < blocks[0].length; index += 1) {
      for (let block = 0; block < blocks.length; block += 1) {
        if (index !== shortBlockLength - eccWords || block >= shortBlocks) result.push(blocks[block][index]);
      }
    }
    assert(result.length === rawCodewords);
    return result;
  }

  drawCodewords(data) {
    let bitIndex = 0;
    for (let right = this.size - 1; right >= 1; right -= 2) {
      if (right === 6) right = 5;
      for (let vertical = 0; vertical < this.size; vertical += 1) {
        for (let column = 0; column < 2; column += 1) {
          const x = right - column;
          const upward = ((right + 1) & 2) === 0;
          const y = upward ? this.size - 1 - vertical : vertical;
          if (!this.isFunction[y][x] && bitIndex < data.length * 8) {
            this.modules[y][x] = getBit(data[bitIndex >>> 3], 7 - (bitIndex & 7));
            bitIndex += 1;
          }
        }
      }
    }
    assert(bitIndex === data.length * 8);
  }

  applyMask(mask) {
    for (let y = 0; y < this.size; y += 1) {
      for (let x = 0; x < this.size; x += 1) {
        let invert;
        switch (mask) {
          case 0: invert = (x + y) % 2 === 0; break;
          case 1: invert = y % 2 === 0; break;
          case 2: invert = x % 3 === 0; break;
          case 3: invert = (x + y) % 3 === 0; break;
          case 4: invert = (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0; break;
          case 5: invert = (x * y) % 2 + (x * y) % 3 === 0; break;
          case 6: invert = ((x * y) % 2 + (x * y) % 3) % 2 === 0; break;
          case 7: invert = ((x + y) % 2 + (x * y) % 3) % 2 === 0; break;
          default: throw new RangeError('QR mask out of range');
        }
        if (!this.isFunction[y][x] && invert) this.modules[y][x] = !this.modules[y][x];
      }
    }
  }

  getPenaltyScore() {
    let score = 0;
    for (let y = 0; y < this.size; y += 1) {
      let runColor = false;
      let runLength = 0;
      const history = [0, 0, 0, 0, 0, 0, 0];
      for (let x = 0; x < this.size; x += 1) {
        if (this.modules[y][x] === runColor) {
          runLength += 1;
          if (runLength === 5) score += 3;
          else if (runLength > 5) score += 1;
        } else {
          addHistory(runLength, runColor, history, this.size);
          if (!runColor) score += countFinderPatterns(history) * 40;
          runColor = this.modules[y][x];
          runLength = 1;
        }
      }
      score += terminateAndCount(runColor, runLength, history, this.size) * 40;
    }
    for (let x = 0; x < this.size; x += 1) {
      let runColor = false;
      let runLength = 0;
      const history = [0, 0, 0, 0, 0, 0, 0];
      for (let y = 0; y < this.size; y += 1) {
        if (this.modules[y][x] === runColor) {
          runLength += 1;
          if (runLength === 5) score += 3;
          else if (runLength > 5) score += 1;
        } else {
          addHistory(runLength, runColor, history, this.size);
          if (!runColor) score += countFinderPatterns(history) * 40;
          runColor = this.modules[y][x];
          runLength = 1;
        }
      }
      score += terminateAndCount(runColor, runLength, history, this.size) * 40;
    }
    for (let y = 0; y < this.size - 1; y += 1) {
      for (let x = 0; x < this.size - 1; x += 1) {
        const color = this.modules[y][x];
        if (color === this.modules[y][x + 1] && color === this.modules[y + 1][x] && color === this.modules[y + 1][x + 1]) score += 3;
      }
    }
    let dark = 0;
    for (const row of this.modules) for (const color of row) dark += color ? 1 : 0;
    const total = this.size * this.size;
    const k = Math.ceil(Math.abs(dark * 20 - total * 10) / total) - 1;
    return score + k * 10;
  }

  getAlignmentPatternPositions() {
    if (this.version === 1) return [];
    const count = Math.floor(this.version / 7) + 2;
    const step = Math.floor((this.version * 8 + count * 3 + 5) / (count * 4 - 4)) * 2;
    const result = [6];
    for (let position = this.size - 7; result.length < count; position -= step) result.splice(1, 0, position);
    return result;
  }

  static getNumRawDataModules(version) {
    let result = (16 * version + 128) * version + 64;
    if (version >= 2) {
      const count = Math.floor(version / 7) + 2;
      result -= (25 * count - 10) * count - 55;
      if (version >= 7) result -= 36;
    }
    return result;
  }

  static getNumDataCodewords(version, ecc) {
    return Math.floor(QrCode.getNumRawDataModules(version) / 8) -
      ECC_CODEWORDS_PER_BLOCK[ecc.ordinal][version] * NUM_ERROR_CORRECTION_BLOCKS[ecc.ordinal][version];
  }
}

function reedSolomonMultiply(x, y) {
  let z = 0;
  for (let index = 7; index >= 0; index -= 1) {
    z = (z << 1) ^ ((z >>> 7) * 0x11d);
    z ^= ((y >>> index) & 1) * x;
  }
  return z;
}

function reedSolomonComputeDivisor(degree) {
  const result = Array(degree - 1).fill(0).concat(1);
  let root = 1;
  for (let index = 0; index < degree; index += 1) {
    for (let j = 0; j < result.length; j += 1) {
      result[j] = reedSolomonMultiply(result[j], root);
      if (j + 1 < result.length) result[j] ^= result[j + 1];
    }
    root = reedSolomonMultiply(root, 0x02);
  }
  return result;
}

function reedSolomonComputeRemainder(data, divisor) {
  const result = divisor.map(() => 0);
  for (const byte of data) {
    const factor = byte ^ result.shift();
    result.push(0);
    divisor.forEach((coefficient, index) => {
      result[index] ^= reedSolomonMultiply(coefficient, factor);
    });
  }
  return result;
}

function addHistory(runLength, runColor, history, size) {
  if (history[0] === 0) runLength += size;
  history.pop();
  history.unshift(runLength);
  return runColor;
}

function countFinderPatterns(history) {
  const n = history[1];
  const core = n > 0 && history[2] === n && history[3] === n * 3 && history[4] === n && history[5] === n;
  return (core && history[0] >= n * 4 && history[6] >= n ? 1 : 0) +
    (core && history[6] >= n * 4 && history[0] >= n ? 1 : 0);
}

function terminateAndCount(runColor, runLength, history, size) {
  if (runColor) {
    addHistory(runLength, runColor, history, size);
    runLength = 0;
  }
  runLength += size;
  addHistory(runLength, false, history, size);
  return countFinderPatterns(history);
}

function renderQrText(payload, options = {}) {
  const qr = QrCode.encodeText(payload, MEDIUM_ECC);
  const border = options.border ?? 4;
  const lines = [];
  const end = qr.size + border;
  // Pair two vertical modules in one terminal cell. This keeps long pairing
  // URLs below common 120-column terminal widths while preserving near-square
  // module proportions for phone cameras.
  for (let y = -border; y < end; y += 2) {
    let line = '';
    for (let x = -border; x < end; x += 1) {
      const top = qr.getModule(x, y);
      const bottom = qr.getModule(x, y + 1);
      line += top ? (bottom ? '█' : '▀') : (bottom ? '▄' : ' ');
    }
    lines.push(line);
  }
  return lines.join('\n');
}

module.exports = {
  MEDIUM_ECC,
  QrCode,
  renderQrText,
};
