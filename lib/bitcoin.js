var bitcoin = require('./cclib').bitcoin
var verify = require('./verify')


/**
 * @member {Object} external:coloredcoinjs-lib.bitcoin
 * @see {@link https://github.com/bitcoinjs/bitcoinjs-lib/ BitcoinJS library}
 */

/**
 * @member {function} external:coloredcoinjs-lib.bitcoin.HDNode
 */

/**
 * @member {function} external:coloredcoinjs-lib.bitcoin.ECKey
 */

/**
 * @member {function} external:coloredcoinjs-lib.bitcoin.ECPubKey
 */

/**
 * @member {function} external:coloredcoinjs-lib.bitcoin.Transaction
 */

/**
 * @deprecated Already exists in coloredcoinjs-lib
 * @param {Buffer} s
 * @return {string}
 */
bitcoin.hashEncode = function (s) {
  console.warn('bitcoin.hashEncode deprecated for removal in v1.0.0, use ' +
               'bitcoin.util.hashEncode')

  return bitcoin.util.hashEncode(s)
}

/**
 * @deprecated Already exists in coloredcoinjs-lib
 * @param {string} s
 * @return {Buffer}
 */
bitcoin.hashDecode = function (s) {
  console.warn('bitcoin.hashDecode deprecated for removal in v1.0.0, use ' +
               'bitcoin.util.hashDecode')

  return bitcoin.util.hashDecode(s)
}

/**
 * Revert bytes order
 *
 * @private
 * @param {string} s
 * @return {string}
 */
function revHex(s) {
  return bitcoin.util.hashDecode(s).toString('hex')
}

/**
 * @typedef {Object} Header
 * @param {number} version
 * @param {string} prevBlockHash
 * @param {string} merkleRoot
 * @param {number} timestamp
 * @param {number} bits
 * @param {number} nonce
 */

/**
 * @param {Header} header
 * @return {Buffer}
 */
bitcoin.util.header2buffer = function (header) {
  verify.object(header)
  verify.number(header.version)
  verify.string(header.prevBlockHash)
  verify.length(header.prevBlockHash, 64)
  verify.string(header.merkleRoot)
  verify.length(header.merkleRoot, 64)
  verify.number(header.timestamp)
  verify.number(header.bits)
  verify.number(header.nonce)

  var buffer = new Buffer(80)
  buffer.writeUInt32LE(header.version, 0)
  buffer.write(revHex(header.prevBlockHash), 4, 32, 'hex')
  buffer.write(revHex(header.merkleRoot), 36, 32, 'hex')
  buffer.writeUInt32LE(header.timestamp, 68)
  buffer.writeUInt32LE(header.bits, 72)
  buffer.writeUInt32LE(header.nonce, 76)

  return buffer
}

bitcoin.header2buffer = function (header) {
  console.warn('bitcoin.header2buffer deprecated for removal in v1.0.0, use ' +
               'bitcoin.util.header2buffer')

  return bitcoin.util.header2buffer(header)
}

/**
 * @param {Buffer} buffer
 * @return {Header}
 */
bitcoin.util.buffer2header = function (buffer) {
  verify.buffer(buffer)
  verify.length(buffer, 80)

  return {
    version: buffer.readUInt32LE(0),
    prevBlockHash: revHex(buffer.slice(4, 36).toString('hex')),
    merkleRoot: revHex(buffer.slice(36, 68).toString('hex')),
    timestamp: buffer.readUInt32LE(68),
    bits: buffer.readUInt32LE(72),
    nonce: buffer.readUInt32LE(76)
  }
}

bitcoin.buffer2header = function (buffer) {
  console.warn('bitcoin.buffer2header deprecated for removal in v1.0.0, use ' +
               'bitcoin.util.buffer2header')

  return bitcoin.util.buffer2header(buffer)
}


/**
 * @param {Buffer} buffer
 * @return {Buffer}
 */
bitcoin.util.headerHash = function (buffer) {
  return Array.prototype.reverse.call(bitcoin.crypto.hash256(buffer))
}

bitcoin.headerHash = function (buffer) {
  console.warn('bitcoin.headerHash deprecated for removal in v1.0.0, use ' +
               'bitcoin.util.headerHash')

  return bitcoin.util.headerHash(buffer)
}


module.exports = bitcoin
