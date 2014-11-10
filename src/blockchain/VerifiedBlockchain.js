var assert = require('assert')
var inherits = require('util').inherits

var BigInteger = require('bigi')
var createError = require('errno').create
var bufferEqual = require('buffer-equal')
var _ = require('lodash')
var LRU = require('lru-cache')
var Q = require('q')
var zfill = require('zfill')

var bitcoin = require('../bitcoin')
var verify = require('../verify')
var Blockchain = require('./Blockchain')
var VerifiedBlockchainStorage = require('./VerifiedBlockchainStorage')


var BlockNotFoundError = createError('BlockNotFoundError')
var NotFoundError = createError('NotFoundError')
var LoopInterrupt = createError('LoopInterrupt')
var VerifyError = createError('VerifyError')
var VerifyChunkError = createError('VerifyChunkError')
var VerifyTxError = createError('VerifyTxError')


/**
 * @class VerifiedBlockchain
 * @extends Blockchain
 * @param {Network} network
 * @param {Object} [opts]
 * @param {boolean} [opts.testnet=false]
 * @param {number} [opts.txCacheSize=250]
 * @param {number} [opts.headerCacheSize=5000] ~391kB
 */
function VerifiedBlockchain(network, opts) {
  verify.Network(network)
  opts = _.extend({ testnet: false, txCacheSize: 250, headerCacheSize: 5000 }, opts)
  verify.boolean(opts.testnet)
  verify.number(opts.txCacheSize)
  verify.number(opts.headerCacheSize)

  var self = this
  Blockchain.call(self)

  self._isTestnet = opts.testnet
  self._network = network

  self._headerCache = LRU({ max: opts.headerCacheSize })
  self._txCache = LRU({ max: opts.txCacheSize })

  self._getVerifiedTxRunning = {}
  self._getVerifiedChunkRunning = {}

  self._currentHeight = -1
  self._currentBlockHash = new Buffer(zfill('', 64), 'hex')
  self._storage = new VerifiedBlockchainStorage()

  var storageChunksCount = self._storage.getChunksCount()
  var storageHeadersCount = self._storage.getHeadersCount()
  if (storageChunksCount > 0 || storageHeadersCount > 0) {
    self._currentHeight = storageChunksCount * 2016 + storageHeadersCount
    self._currentBlockHash = self._storage.getLastHash()
  }

  var running = false
  var queue = []
  function onNewHeight() {
    var promise = Q()

    if (running) {
      queue.push(Q.defer())
      promise = _.last(queue)
    }
    running = true

    promise.then(function() {
      return self._sync()

    }).catch(function(error) {
      self.emit('error', error)

    }).finally(function() {
      running = false
      if (queue.length > 0)
        queue.pop().resolve()
    })
  }

  self._network.on('newHeight', onNewHeight)
  onNewHeight()

  self._network.on('touchAddress', function(address) {
    self.emit('touchAddress', address)
  })

  self.on('newHeight', function() {
    self._txCache.forEach(function(value, key) {
      if (value.height === 0)
        self._txCache.del(key)
    })
  })
}

inherits(VerifiedBlockchain, Blockchain)

/**
 * {@link Blockchain~getCurrentHeight}
 */
VerifiedBlockchain.prototype.getCurrentHeight = function() {
  return this._currentHeight
}

/**
 * {@link Blockchain~getBlockTime}
 */
VerifiedBlockchain.prototype.getBlockTime = function(height, cb) {
  verify.function(cb)

  this._getVerifiedHeader(height)
    .done(function(header) { cb(null, header.timestamp) }, function(error) { cb(error) })
}

/**
 * {@link Blockchain~getTx}
 */
VerifiedBlockchain.prototype.getTx = function(txId, cb) {
  verify.function(cb)

  this._getVerifiedTx(txId)
    .done(function(tx) { cb(null, tx) }, function(error) { cb(error) })
}

/**
 * {@link Blockchain~sendTx}
 */
VerifiedBlockchain.prototype.sendTx = function(tx, cb) {
  this._network.sendTx(tx, cb)
}

/**
 * {@link Blockchain~getHistory}
 */
VerifiedBlockchain.prototype.getHistory = function(address, cb) {
  this._network.getHistory(address, cb)
}

/**
 * {@link Blockchain~subscribeAddress}
 */
VerifiedBlockchain.prototype.subscribeAddress = function(address, cb) {
  this._network.subscribeAddress(address, cb)
}

/**
 */
VerifiedBlockchain.prototype.clear = function() {
  this._storage.clear()
}

/**
 * @param {number} height
 * @return {Q.Promise}
 */
VerifiedBlockchain.prototype._waitHeight = function(height) {
  var self = this

  var deferred = Q.defer()

  function onNewHeight() {
    if (height <= self.getCurrentHeight())
      deferred.resolve()
  }
  self.on('newHeight', onNewHeight)
  onNewHeight()

  return deferred.promise.finally(function() {
    self.removeListener('newHeight', onNewHeight)
  })
}

/**
 * @param {number} chunkIndex
 * @return {Q.Promise<Buffer>}
 */
VerifiedBlockchain.prototype._getVerifiedChunk = function(chunkIndex) {
  var self = this

  if (_.isUndefined(self._getVerifiedChunkRunning[chunkIndex])) {
    var promise = Q.ninvoke(self._network, 'getChunk', chunkIndex).then(function(chunkHex) {
      var chunk = new Buffer(chunkHex, 'hex')

      var chunkHash = bitcoin.crypto.hash256(chunk).toString('hex')
      if (chunkHash !== self._storage.getChunkHash(chunkIndex))
        throw new VerifyChunkError('Chunk: ' + chunkIndex)

      _.range(0, 2016).forEach(function(offset) {
        var header = chunk.slice(offset*80, (offset+1)*80)
        self._headerCache.set(chunkIndex*2016 + offset, header)
      })

      return chunk

    }).finally(function() { delete self._getVerifiedChunkRunning[chunkIndex] })

    self._getVerifiedChunkRunning[chunkIndex] = promise
  }

  return self._getVerifiedChunkRunning[chunkIndex]
}

/**
 * @typedef {Object} HeaderObject
 * @property {number} version
 * @property {string} prevBlockHash
 * @property {string} merkleRoot
 * @property {number} timestamp
 * @property {number} bits
 * @property {number} nonce
 */

/**
 * @param {number} height
 * @return {Q.Promise<HeaderObject>}
 */
VerifiedBlockchain.prototype._getHeader = function(height) {
  return Q.ninvoke(this._network, 'getHeader', height)
}

/**
 * @param {number} height
 * @return {Q.Promise<Buffer>}
 */
VerifiedBlockchain.prototype._getVerifiedHeader = function(height) {
  verify.number(height)

  var self = this
  if (!_.isUndefined(self._headerCache.get(height)))
    return Q(self._headerCache.get(height))

  var promise = Q()
  if (height > self.getCurrentHeight() && height <= self._network.getCurrentHeight())
    promise = self._waitHeight(height)

  return promise.then(function() {
    var chunkIndex = Math.floor(height / 2016)
    var headerIndex = height % 2016

    if (chunkIndex === self._storage.getChunksCount()) {
      if (headerIndex >= self._storage.getHeadersCount())
        throw new NotFoundError('Height: ' + height)

      return new Buffer(self._storage.getHeader(headerIndex), 'hex')
    }

    return self._getVerifiedChunk(chunkIndex).then(function(chunk) {
      return chunk.slice(headerIndex*80, (headerIndex+1)*80)
    })
  })
}

/**
 * @param {string} txId
 * @return {Q.Promise<Transaction>}
 */
VerifiedBlockchain.prototype._getTx = function(txId) {
  return Q.ninvoke(this._network, 'getTx', txId)
}

/**
 * @param {string} txId
 * @return {Q.Promise<Transaction>}
 */
VerifiedBlockchain.prototype._getVerifiedTx = function(txId) {
  verify.txId(txId)

  var self = this
  if (!_.isUndefined(self._txCache.get(txId)))
    return Q(self._txCache.get(txId))

  if (_.isUndefined(self._getVerifiedTxRunning[txId])) {
    var tx, height, merkleRoot

    var promise = self._getTx(txId).then(function(result) {
      tx = result
      return Q.ninvoke(self._network, 'getMerkle', txId).catch(function(error) {
        if (error.message === 'BlockNotFound')
          throw new BlockNotFoundError()

        throw error
      })

    }).then(function(result) {
      height = result.height

      var hash = bitcoin.hashDecode(txId)
      result.merkle.forEach(function(txId, i) {
        var items
        if ((result.index >> i) & 1)
          items = [bitcoin.hashDecode(txId), hash]
        else
          items = [hash, bitcoin.hashDecode(txId)]

        hash = bitcoin.crypto.hash256(Buffer.concat(items))
      })
      merkleRoot = bitcoin.hashEncode(hash)

      return self._getVerifiedHeader(height)

    }).then(function(buffer) {
      var header = bitcoin.buffer2header(buffer)
      if (header.merkleRoot !== merkleRoot)
        throw new VerifyTxError('TxId: ' + txId)

    }).catch(function(error) {
      if (error.type !== 'BlockNotFoundError')
        throw error

      height = 0

    }).then(function() {
      self._txCache.set(txId, { height: height, tx: tx })
      return tx

    }).finally(function() { delete self._getVerifiedTxRunning[txId] })

    self._getVerifiedTxRunning[txId] = promise
  }

  return self._getVerifiedTxRunning[txId]
}

/**
 * @return {Q.Promise}
 */
VerifiedBlockchain.prototype._sync = function() {
  var self = this
  var deferred = Q.defer()

  var networkHeight = self._network.getCurrentHeight()
  var networkLastHash = self._network.getCurrentBlockHash()

  if (bufferEqual(self._currentBlockHash, networkLastHash) || networkHeight === -1) {
    deferred.resolve()
    return deferred.promise
  }

  var maxBits = 0x1d00ffff
  var maxTarget = new Buffer('00000000FFFF0000000000000000000000000000000000000000000000000000', 'hex')
  var maxTargetBI = BigInteger.fromHex(maxTarget.toString('hex'))
  var chain = [], networkIndex, index

  /**
   * @param {number} index
   * @param {Buffer[]} chain
   * @return {Q.Promise<{bits: number, target: Buffer}>}
   */
  function getTarget(index, chain) {
    chain = chain || []

    if (index === 0)
      return Q({ bits: maxBits, target: maxTarget })

    var firstHeader, lastHeader
    return self._getVerifiedHeader((index-1)*2016).then(function(buffer) {
      firstHeader = bitcoin.buffer2header(buffer)

    }).then(function() {
      return self._getVerifiedHeader(index*2016-1).then(function(buffer) {
        lastHeader = bitcoin.buffer2header(buffer)

      }).catch(function(error) {
        if (error.type !== 'NotFoundError')
          throw error

      }).then(function() {
        chain.forEach(function(data) {
          if (data.height === index*2016 - 1)
            lastHeader = data.header
        })
      })

    }).then(function() {
      var nActualTimestamp = lastHeader.timestamp - firstHeader.timestamp
      var nTargetTimestamp = 14*24*60*60
      nActualTimestamp = Math.max(nActualTimestamp, nTargetTimestamp/4)
      nActualTimestamp = Math.min(nActualTimestamp, nTargetTimestamp*4)

      var bits = lastHeader.bits
      var MM = 256*256*256
      var a = bits % MM
      if (a < 0x8000)
        a = a * 256

      var target = BigInteger(a.toString(), 10)
      target = target.multiply(BigInteger('2', 10).pow(8 * (Math.floor(bits/MM) - 3)))
      target = target.multiply(BigInteger(nActualTimestamp.toString(), 10))
      target = target.divide(BigInteger(nTargetTimestamp.toString(), 10))
      target = target.min(maxTargetBI)

      var c = zfill(target.toHex(), 64)
      var i = 32
      while (c.slice(0, 2) === '00') {
        c = c.slice(2)
        i -= 1
      }

      c = parseInt(c.slice(0, 6), 16)
      if (c > 0x800000) {
        c = Math.floor(c / 256)
        i += 1
      }

      return { bits: c + MM*i, target: new Buffer(target.toHex(), 'hex') }
    })
  }

  /**
   * @param {Buffer} hash
   * @param {Buffer} target
   * @return {boolean}
   */
  function isGoodHash(hash, target) {
    for (var i = 0; i < 32; ++i)
      if (hash[i] < target[i])
        return true

    return false
  }

  /**
   * @param {Buffer} currentHash
   * @param {Header} currentHeader
   * @param {Buffer} prevHash
   * @param {Header} prevHeader
   * @param {{bits: number, target: Buffer}} target
   * @throws {VerifyError}
   */
  function verifyHeader(currentHash, currentHeader, prevHash, prevHeader, target) {
    try {
      assert.equal(prevHash.toString('hex'), currentHeader.prevBlockHash)

      try {
        assert.equal(currentHeader.bits, target.bits)
        assert.equal(isGoodHash(currentHash, target.target), true)

      } catch (error) {
        var isAssertionError = error instanceof assert.AssertionError
        var interval = currentHeader.timestamp - prevHeader.timestamp
        if (!(isAssertionError && self._isTestnet && interval > 1200))
          throw error

        assert.equal(currentHeader.bits, maxBits)
        assert.equal(isGoodHash(currentHash, maxTarget), true)
      }

    } catch(error) {
      if (error instanceof assert.AssertionError)
        throw new VerifyError('Chain verification failed')

      throw error
    }
  }

  /**
   */
  function runChainLoopOnce() {
    var height = (_.last(chain) || { height: self.getCurrentHeight() }).height + 1
    if (height <= networkHeight)
      return self._getHeader(height).then(function(header) {
        chain.push({ height: height, header: header })
        runChainLoopOnce()
      })

    self._getVerifiedHeader(self.getCurrentHeight()).then(function(buffer) {
      var prevHeader = bitcoin.buffer2header(buffer)
      var prevHash = bitcoin.headerHash(buffer)

      if (prevHash.toString('hex') !== chain[0].header.prevBlockHash)
        throw new LoopInterrupt()

      var promise = Q()
      chain.forEach(function(data) {
        promise = promise.then(function() {
          return getTarget(Math.floor(data.height/2016), chain).then(function(target) {
            var currentHash = bitcoin.headerHash(bitcoin.header2buffer(data.header))

            verifyHeader(currentHash, data.header, prevHash, prevHeader, target)

            prevHeader = data.header
            prevHash = currentHash
          })
        })
      })

      return promise

    }).then(function() {
      var lastBlock = bitcoin.header2buffer(_.last(chain).header)
      var lastBlockHash = bitcoin.headerHash(lastBlock).toString('hex')
      self._storage.setLastHash(lastBlockHash)

      var chunkIndex = Math.floor(_.last(chain).height / 2016)
      var headerIndex = _.last(chain).height % 2016

      if (chunkIndex === self._storage.getChunksCount()) {
        self._storage.truncateHeaders(headerIndex)
        chain.forEach(function(obj) {
          self._storage.pushHeader(bitcoin.header2buffer(obj.header).toString('hex'))
        })

      } else {
        assert.equal(chunkIndex-1, self._storage.getChunksCount())
        var startHeight = chunkIndex * 2016

        var chunkHex = ''
        _.range(self._storage.getHeadersCount()).forEach(function(offset) {
          chunkHex += self._storage.getHeader(offset)
        })
        chain.forEach(function(obj) {
          if (obj.height < startHeight)
            chunkHex += bitcoin.header2buffer(obj.header).toString('hex')
        })
        assert.equal(chunkHex.length, 2016*160)

        var chunk = new Buffer(chunkHex, 'hex')
        var chunkHash = bitcoin.crypto.hash256(chunk).toString('hex')
        self._storage.pushChunkHash(chunkHash)

        self._storage.truncateHeaders(0)
        chain.forEach(function(obj) {
          if (obj.height >= startHeight)
            self._storage.pushHeader(bitcoin.header2buffer(obj.header).toString('hex'))
        })
      }

      self._currentBlockHash = self._storage.getLastHash()
      self._currentHeight = _.last(chain).height
      self.emit('newHeight')

      deferred.resolve()

    }).catch(function(error) {
      if (error instanceof LoopInterrupt)
        startChunkLoop()
      else
        deferred.reject(error)
    })
  }

  /**
   */
  function runChunkLoopOnce() {
    if (index > networkIndex)
      return deferred.resolve()

    var chunk, prevHash, prevHeader
    Q.ninvoke(self._network, 'getChunk', index).then(function(chunkHex) {
      chunk = new Buffer(chunkHex, 'hex')

      if (index > 0)
        return self._getVerifiedHeader(index*2016 - 1)

      prevHash = new Buffer(zfill('', 64), 'hex')

    }).then(function(buffer) {
      if (Buffer.isBuffer(buffer) && buffer.length === 80) {
        prevHash = bitcoin.headerHash(buffer)
        prevHeader = bitcoin.buffer2header(buffer)
      }

      var chunkFirstHeader = bitcoin.buffer2header(chunk.slice(0, 80))
      if (chunkFirstHeader.prevBlockHash === prevHash.toString('hex'))
        return getTarget(index)

      index -= 1
      throw new LoopInterrupt()

    }).then(function(target) {
      _.range(0, chunk.length, 80).forEach(function(offset) {
        var currentHeader = bitcoin.buffer2header(chunk.slice(offset, offset+80))
        var currentHash = bitcoin.headerHash(chunk.slice(offset, offset+80))

        verifyHeader(currentHash, currentHeader, prevHash, prevHeader, target)

        prevHeader = currentHeader
        prevHash = currentHash
      })

    }).then(function() {
      self._storage.setLastHash(bitcoin.headerHash(chunk.slice(-80)).toString('hex'))
      self._storage.truncateHeaders(0)

      if (chunk.length === 2016*80) {
        self._storage.truncateChunks(index)
        self._storage.pushChunkHash(bitcoin.crypto.hash256(chunk).toString('hex'))

      } else {
        _.range(0, chunk.length, 80).forEach(function(offset) {
          self._storage.pushHeader(chunk.slice(offset, offset+80).toString('hex'))
        })

      }

      self._currentBlockHash = self._storage.getLastHash()
      self._currentHeight = index*2016 + chunk.length/80 - 1
      self.emit('newHeight')

      index += 1
      runChunkLoopOnce()

    }).catch(function(error) {
      if (error instanceof LoopInterrupt)
        runChunkLoopOnce()
      else
        deferred.reject(error)
    })
  }

  /**
   */
  function startChunkLoop() {
    networkIndex = Math.max(Math.floor(networkHeight / 2016), 0)
    index = Math.max(Math.floor(self.getCurrentHeight() / 2016), 0)
    index = Math.min(index, networkIndex)
    runChunkLoopOnce()
  }

  // chunk loop used for revert even need revert one block,
  //   otherwise logic chain loop will be very difficult
  if (networkHeight - self.getCurrentHeight() < 50)
    runChainLoopOnce()
  else
    startChunkLoop()

  return deferred.promise
}


module.exports = VerifiedBlockchain