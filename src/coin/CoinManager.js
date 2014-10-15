var bitcoin = require('coloredcoinjs-lib').bitcoin
var _ = require('lodash')
var Q = require('q')

var cclib = require('coloredcoinjs-lib')

var Coin = require('./Coin')


/**
 * @class CoinManager
 *
 * @param {Wallet} wallet
 * @param {CoinStorage} storage
 */
function CoinManager(wallet, storage) {
  this.wallet = wallet
  this.storage = storage
}

/**
 * @callback CoinManager~applyTx
 * @param {?Error} error
 */

/**
 * @param {bitcoinjs-lib.Transaction} tx
 * @param {CoinManager~applyTx} cb
 */
CoinManager.prototype.applyTx = function(tx, cb) {
  var self = this

  return Q.fcall(function() {
    var assetdefs = self.wallet.getAllAssetDefinitions()
    var addresses = _.flatten(
      assetdefs.map(function(assetdef) { return self.wallet.getAllAddresses(assetdef) }))

    tx.ins.forEach(function(input) {
      var txId = Array.prototype.reverse.call(new Buffer(input.hash)).toString('hex')
      self.storage.markCoinAsSpend(txId, input.index)
    })

    var promises = tx.outs.map(function(output, index) {
      var script = bitcoin.Script.fromBuffer(output.script.toBuffer())
      var address = bitcoin.Address.fromOutputScript(script, self.wallet.getNetwork()).toBase58Check()

      if (addresses.indexOf(address) === -1)
        return

      self.storage.add({
        txId: tx.getId(),
        outIndex: index,
        value: output.value,
        script: output.script,
        address: address
      })

      var coin = self.record2Coin(self.storage.get(tx.getId(), index))
      return Q.ninvoke(coin, 'getMainColorValue')
    })

    return Q.all(promises)

  }).done(function() { cb(null) }, function(error) { cb(error) })
}

/**
 * @param {CoinStorageRecord} record
 * @return {Coin}
 */
CoinManager.prototype.record2Coin = function(record) {
  var coin = new Coin(this, {
    txId: record.txId,
    outIndex: record.outIndex,
    value: record.value,
    script: record.script,
    address: record.address
  })

  return coin
}

/**
 * @param {string} address
 * @return {Coin[]}
 */
CoinManager.prototype.getCoinsForAddress = function(address) {
  var records = this.storage.getForAddress(address)
  return records.map(this.record2Coin.bind(this))
}

/**
 * @param {Coin} coin
 * @return {boolean}
 */
CoinManager.prototype.isCoinSpent = function(coin) {
  return this.storage.isSpent(coin.txId, coin.outIndex)
}

/**
 * @callback CoinManager~isConfirmed
 * @param {?Error} error
 * @param {boolean} isConfirmed
 */

/**
 * @param {Coin} coin
 * @param {CoinManager~isConfirmed} cb
 */
CoinManager.prototype.isCoinConfirmed = function(coin, cb) {
  Q.ninvoke(this.wallet.getTxDb(), 'isTxConfirmed', coin.txId)
  .done(function(isConfirmed) { cb(null, isConfirmed) }, function(error) { cb(error) })
}

/**
 * @callback CoinManager~getCoinColorValue
 * @param {?Error} error
 * @param {ColorValue} colorValue
 */

/**
 * @param {Coin} coin
 * @param {ColorDefinition} colorDefinition
 * @param {CoinManager~getCoinColorValue} cb
 */
CoinManager.prototype.getCoinColorValue = function(coin, colorDefinition, cb) {
  var bs = this.wallet.getBlockchain()
  this.wallet.getColorData().getColorValue(coin.txId, coin.outIndex, colorDefinition, bs.getTx.bind(bs), cb)
}

/**
 * @callback CoinManager~getMainColorValue
 * @param {?Error} error
 * @param {ColorValue} coinColorValue
 */

/**
 * Get one ColorValue or error if more than one
 *
 * @param {CoinManager~getMainColorValue} cb
 */
CoinManager.prototype.getMainCoinColorValue = function(coin, cb) {
  var cdManager = this.wallet.getColorDefinitionManager()

  Q.fcall(function() {
    var coinColorValue = null

    var promises = cdManager.getAllColorDefinitions().map(function(colorDefinition) {
      return Q.ninvoke(coin, 'getColorValue', colorDefinition).then(function(colorValue) {
        if (coinColorValue !== null && colorValue !== null)
          throw new Error('Coin ' + coin + ' have more that one ColorValue')

        coinColorValue = colorValue
      })
    })

    return Q.all(promises).then(function() { return coinColorValue })

  }).then(function(coinColorValue) {
    if (coinColorValue === null)
      coinColorValue = new cclib.ColorValue(cdManager.getUncolored(), coin.value)

    return coinColorValue

  }).done(function(coinColorValue) { cb(null, coinColorValue) }, function(error) { cb(error) })
}

module.exports = CoinManager
