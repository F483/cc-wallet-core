var events = require('events')
var inherits = require('util').inherits

var _ = require('lodash')
var Q = require('q')

var address = require('../address')
var asset = require('../asset')
var blockchain = require('../blockchain')
var coin = require('../coin')
var ConfigStorage = require('../ConfigStorage')
var network = require('../network')
var tx = require('../tx')
var WalletStateManager = require('./WalletStateManager')

var cclib = require('../cclib')
var bitcoin = require('../bitcoin')
var errors = require('../errors')
var util = require('../util')
var verify = require('../verify')


/**
 * @event Wallet#error
 * @param {Error} error
 */

/**
 * @event Wallet#newHeight
 * @param {number} height
 */

/**
 * @event Wallet#addTx
 * @param {Transaction} tx
 */

/**
 * @event Wallet#updateTx
 * @param {string} tx
 */

/**
 * @event Wallet#revertTx
 * @param {Transaction} tx
 */

/**
 * @event Wallet#newAddress
 * @param {Address} address
 */

/**
 * @event Wallet#touchAddress
 * @param {string} address
 */

/**
 * @event Wallet#newAsset
 * @param {AssetDefinition} assetdef
 */

/**
 * @event Wallet#touchAsset
 * @param {AssetDefinition} assetdef
 */

/**
 * @event Wallet#historyUpdate
 */

/**
 * @event Wallet#syncStart
 */

/**
 * @event Wallet#syncStop
 */

/**
 * @event Wallet#initialize
 */

/**
 * @callback Wallet~errorCallback
 * @param {?Error} error
 */

/**
 * @class Wallet
 * @extends events.EventEmitter
 * @mixes SyncMixin
 *
 * @param {Object} opts
 * @param {boolean} [opts.testnet=false]
 * @param {string} [opts.network=Electrum]
 * @param {Object} [opts.networkOpts]
 * @param {string} [opts.blockchain=VerifiedBlockchain]
 * @param {number} [opts.storageSaveTimeout=1000] In milliseconds
 * @param {boolean} [opts.spendUnconfirmedCoins=false]
 * @param {Object[]} [opts.systemAssetDefinitions]
 */
function Wallet(opts) {
  opts = _.extend({
    testnet: false,
    network: 'Electrum',
    blockchain: 'VerifiedBlockchain',
    storageSaveTimeout: 1000,
    spendUnconfirmedCoins: false
  }, opts)

  var self = this
  events.EventEmitter.call(self)
  util.SyncMixin.call(self)

  verify.boolean(opts.testnet)
  verify.string(opts.network)
  opts.networkOpts = _.extend({testnet: opts.testnet}, opts.networkOpts)
  verify.boolean(opts.networkOpts.testnet)
  verify.string(opts.blockchain)
  verify.number(opts.storageSaveTimeout)
  verify.boolean(opts.spendUnconfirmedCoins)

  self.bitcoinNetwork = opts.testnet ? bitcoin.networks.testnet : bitcoin.networks.bitcoin
  self._spendUnconfirmedCoins = opts.spendUnconfirmedCoins

  self.config = new ConfigStorage()

  self.network = new network[opts.network](self, opts.networkOpts)
  self.blockchainStorage = new blockchain.VerifiedBlockchainStorage()
  var BlockchainCls = blockchain[opts.blockchain]
  self.blockchain = new BlockchainCls(
    self.network, {testnet: opts.testnet, storage: self.blockchainStorage})

  self.cdStorage = new cclib.ColorDefinitionStorage()
  self.cdManager = new cclib.ColorDefinitionManager(self.cdStorage)

  self.cDataStorage = new cclib.ColorDataStorage()
  self.cData = new cclib.ColorData(self.cDataStorage)

  self.aStorage = new address.AddressStorage()
  self.aManager = new address.AddressManager(self.aStorage, self.bitcoinNetwork)

  self.adStorage = new asset.AssetDefinitionStorage()
  self.adManager = new asset.AssetDefinitionManager(self.cdManager, self.adStorage)
  if (opts.systemAssetDefinitions) {
    opts.systemAssetDefinitions.forEach(function (sad) {
      self.adManager.resolveAssetDefinition(sad)
    })
  }

  self.walletStateManager = new WalletStateManager(self)

  self.txFetcher = new tx.TxFetcher(self)

  // events
  self.network.on('error', function (error) { self.emit('error', error) })
  self.blockchain.on('error', function (error) { self.emit('error', error) })
  self.txFetcher.on('error', function (error) { self.emit('error', error) })

  self.blockchain.on('newHeight', function (height) { self.emit('newHeight', height) })

  self.aManager.on('newAddress', function (address) { self.emit('newAddress', address) })
  self.adManager.on('newAsset', function (assetdef) { self.emit('newAsset', assetdef) })

  self.walletStateManager.on('error', function (error) { self.emit('error', error) })
  self.walletStateManager.on('syncStart', function () { self._syncEnter() })
  self.walletStateManager.on('syncStop', function () { self._syncExit() })
  self.walletStateManager.on('addTx', function (tx) { self.emit('addTx', tx) })
  self.walletStateManager.on('updateTx', function (tx) { self.emit('updateTx', tx) })
  self.walletStateManager.on('revertTx', function (tx) { self.emit('revertTx', tx) })
  self.walletStateManager.on('touchAddress', function (address) { self.emit('touchAddress', address) })
  self.walletStateManager.on('touchAsset', function (assetdef) { self.emit('touchAsset', assetdef) })
  self.walletStateManager.on('historyUpdate', function () { self.emit('historyUpdate') })

  self._allAddressesCache = undefined
  self.on('newAddress', function () { self._allAddressesCache = undefined })
}

inherits(Wallet, events.EventEmitter)

Wallet.prototype.getBitcoinNetwork = function () { return this.bitcoinNetwork }
Wallet.prototype.canSpendUnconfirmedCoins = function () { return this._spendUnconfirmedCoins }
Wallet.prototype.getBlockchain = function () { return this.blockchain }
Wallet.prototype.getColorDefinitionManager = function () { return this.cdManager }
Wallet.prototype.getColorData = function () { return this.cData }
Wallet.prototype.getAddressManager = function () { return this.aManager }
Wallet.prototype.getAssetDefinitionManager = function () { return this.adManager }
Wallet.prototype.getCoinQuery = function () { return new coin.CoinQuery(this) }
Wallet.prototype.getStateManager = function () { return this.walletStateManager }

/**
 * @return {boolean}
 */
Wallet.prototype.isInitialized = function () {
  return this.config.get('initialized') || false
}

/**
 * @throws {Error} If not initialized
 */
Wallet.prototype.isInitializedCheck = function () {
  if (!this.isInitialized()) {
    throw new errors.WalletNotInitializedError()
  }
}

/**
 * @param {string} seedHex
 * @throws {Error} If already initialized
 */
Wallet.prototype.initialize = function (seedHex) {
  verify.hexString(seedHex)

  if (this.isInitialized()) {
    throw new errors.WalletAlreadyInitializedError()
  }

  var addressManager = this.getAddressManager()
  this.getAssetDefinitionManager().getAllAssets().forEach(function (assetdef) {
    if (addressManager.getAllAddresses(assetdef).length === 0) {
      addressManager.getNewAddress(assetdef, seedHex)
    }
  })

  this.config.set('initialized', true)
  this.emit('initialize')
}

/**
 * @param {string} seedHex
 * @throws {Error} If not initialized
 */
Wallet.prototype.isCurrentSeed = function (seedHex) {
  this.isInitializedCheck()
  return this.getAddressManager().isCurrentSeed(seedHex)
}


/**
 * @param {string} seedHex
 * @param {Object} data
 * @param {string[]} data.monikers
 * @param {string[]} data.colorDescs
 * @param {number} [data.unit=1]
 * @return {AssetDefinition}
 * @throws {Error} If asset already exists or not currently seedHex
 */
Wallet.prototype.addAssetDefinition = function (seedHex, data) {
  this.isInitializedCheck()
  this.getAddressManager().isCurrentSeedCheck(seedHex)

  var assetdef = this.getAssetDefinitionManager().resolveAssetDefinition(data)
  if (this.getSomeAddress(assetdef) === null) {
    this.getNewAddress(seedHex, assetdef)
  }

  return assetdef
}

/**
 * @param {string} moniker
 * @return {?AssetDefinition}
 * @throws {Error} If not initialized
 */
Wallet.prototype.getAssetDefinitionByMoniker = function (moniker) {
  this.isInitializedCheck()
  return this.getAssetDefinitionManager().getByMoniker(moniker)
}

/**
 * @return {AssetDefinition[]}
 * @throws {Error} If not initialized
 */
Wallet.prototype.getAllAssetDefinitions = function () {
  this.isInitializedCheck()
  return this.getAssetDefinitionManager().getAllAssets()
}

/**
 * Param asColorAddress in address method not good solution
 * But sometimes we need bitcoin address for ColorDefintion,
 *  such as in OperationalTx.getChangeAddress
 */

/**
 * Create new address for given asset
 *
 * @param {string} seedHex
 * @param {AssetDefinition} assetdef
 * @param {boolean} [asColorAddress=false]
 * @return {string}
 * @throws {Error} If wallet not initialized or not currently seedHex
 */
Wallet.prototype.getNewAddress = function (seedHex, assetdef, asColorAddress) {
  this.isInitializedCheck()

  var address = this.getAddressManager().getNewAddress(assetdef, seedHex)

  if (asColorAddress) {
    return address.getColorAddress()
  }

  return address.getAddress()
}

/**
 * Return all addresses for given asset
 *
 * @param {(AssetDefinition|ColorDefinition)} [assetdef]
 * @param {boolean} [asColorAddress=false]
 * @return {string[]}
 * @throws {Error} If wallet not initialized
 */
Wallet.prototype.getAllAddresses = function (assetdef, asColorAddress) {
  var self = this
  self.isInitializedCheck()

  if (_.isUndefined(self._allAddressesCache)) {
    self._allAddressesCache = {colored: {}, uncolored: {}}
    self.getAllAssetDefinitions().forEach(function (assetdef) {
      var addresses = self.getAddressManager().getAllAddresses(assetdef)
      self._allAddressesCache.colored[assetdef.getId()] = addresses.map(function (o) { return o.getColorAddress() })
      self._allAddressesCache.uncolored[assetdef.getId()] = addresses.map(function (o) { return o.getAddress() })
    })
  }

  var addresses = self._allAddressesCache
  if (!_.isUndefined(assetdef)) {
    if (assetdef instanceof cclib.ColorDefinition) {
      assetdef = self.getAssetDefinitionManager().getByDesc(assetdef.getDesc())
    }

    verify.AssetDefinition(assetdef)
    addresses = {
      colored: [addresses.colored[assetdef.getId()] || []],
      uncolored: [addresses.uncolored[assetdef.getId()] || []]
    }
  }

  if (_.isUndefined(asColorAddress)) { asColorAddress = false }
  verify.boolean(asColorAddress)

  return _.chain(asColorAddress ? addresses.colored : addresses.uncolored)
    .values()
    .flatten()
    .uniq()
    .value()
}

/**
 * Return first address for given asset or throw Error
 *
 * @param {AssetDefinition} assetdef
 * @param {boolean} [asColorAddress=false]
 * @return {?string}
 * @throws {Error} If wallet not initialized
 */
Wallet.prototype.getSomeAddress = function (assetdef, asColorAddress) {
  this.isInitializedCheck()

  var addresses = this.getAllAddresses(assetdef, asColorAddress)
  if (addresses.length > 0) {
    return addresses[0]
  }

  return null
}

/**
 * {@link Address.getBitcoinAddress}
 */
Wallet.prototype.getBitcoinAddress = function (assetdef, colorAddress) {
  return address.Address.getBitcoinAddress(assetdef, colorAddress)
}

/**
 * {@link Address.checkAddress}
 */
Wallet.prototype.checkAddress = function (assetdef, checkedAddress) {
  return address.Address.checkColorAddress(assetdef, checkedAddress)
}

/**
 * @param {string} address
 * @param {Wallet~errorCallback} cb
 */
Wallet.prototype.subscribeAndSyncAddress = function (address, cb) {
  verify.string(address)
  verify.function(cb)

  this.isInitializedCheck()

  this.txFetcher.subscribeAndSyncAddress(address, cb)
}

/**
 * @param {Wallet~errorCallback} cb
 */
Wallet.prototype.subscribeAndSyncAllAddresses = function (cb) {
  verify.function(cb)

  this.isInitializedCheck()

  var addresses = _.chain(this.getAllAssetDefinitions())
    .map(function (assetdef) { return this.getAllAddresses(assetdef) }, this)
    .flatten()
    .uniq()
    .value()

  this.txFetcher.subscribeAndSyncAllAddresses(addresses, cb)
}

/**
 * @callback Wallet~getBalance
 * @param {?Error} error
 * @param {Object} balance
 * @param {number} balance.total
 * @param {number} balance.available
 * @param {number} balance.unconfirmed
 */

/**
 * @param {AssetDefinition} assetdef
 * @param {Wallet~getBalance} cb
 * @throws {Error} If wallet not initialized
 */
Wallet.prototype.getBalance = function (assetdef, cb) {
  verify.AssetDefinition(assetdef)
  verify.function(cb)

  var self = this
  self.isInitializedCheck()

  Q.fcall(function () {
    var coinQuery = self.getCoinQuery()
    coinQuery = coinQuery.includeUnconfirmed()
    coinQuery = coinQuery.onlyColoredAs(assetdef.getColorSet().getColorDefinitions())
    coinQuery = coinQuery.onlyAddresses(self.getAllAddresses(assetdef))

    return Q.ninvoke(coinQuery, 'getCoins')

  }).then(function (coinList) {
    return Q.ninvoke(coinList, 'getValues')

  }).then(function (values) {
    var result = {}

    function getValue(name) {
      if (values[name].length > 0) {
        result[name] = values[name][0].getValue()
      } else {
        result[name] = 0
      }
    }

    getValue('total')
    getValue('available')
    getValue('unconfirmed')

    return result

  }).done(function (result) { cb(null, result) }, function (error) { cb(error) })
}

/**
 * @callback Wallet~getBalanceType
 * @param {?Error} error
 * @param {number} balance
 */

/**
 * @param {AssetDefinition} assetdef
 * @param {Wallet~getBalanceType} cb
 * @throws {Error} If wallet not initialized
 */
Wallet.prototype.getTotalBalance = function (assetdef, cb) {
  Q.ninvoke(this, 'getBalance', assetdef)
    .done(function (balance) { cb(null, balance.total) }, function (error) { cb(error) })
}

/**
 * @param {AssetDefinition} assetdef
 * @param {Wallet~getBalanceType} cb
 * @throws {Error} If wallet not initialized
 */
Wallet.prototype.getAvailableBalance = function (assetdef, cb) {
  Q.ninvoke(this, 'getBalance', assetdef)
    .done(function (balance) { cb(null, balance.available) }, function (error) { cb(error) })
}

/**
 * @param {AssetDefinition} assetdef
 * @param {Wallet~getBalanceType} cb
 * @throws {Error} If wallet not initialized
 */
Wallet.prototype.getUnconfirmedBalance = function (assetdef, cb) {
  Q.ninvoke(this, 'getBalance', assetdef)
    .done(function (balance) { cb(null, balance.unconfirmed) }, function (error) { cb(error) })
}

/**
 * {@link WalletStateManager~getEntries}
 */
Wallet.prototype.getHistory = function (assetdef) {
  return this.getStateManager().getHistory(assetdef)
}

/**
 * @typedef {Object} rawTarget
 * @property {number} value Target value in satoshi
 * @property {string} [address] Target address
 */

/**
 * @callback Wallet~createTx
 * @param {?Error} error
 * @param {ComposedTx} tx
 */

/**
 * @param {AssetDefinition} assetdef
 * @param {rawTarget[]} rawTargets
 * @param {Wallet~createTx} cb
 * @throws {Error} If wallet not initialized
 */
Wallet.prototype.createTx = function (assetdef, rawTargets, cb) {
  verify.array(rawTargets)
  verify.function(cb)

  var self = this
  self.isInitializedCheck()

  var assetTargets = rawTargets.map(function (rawTarget) {
    // @todo Add multisig support
    var script = bitcoin.Address.fromBase58Check(rawTarget.address).toOutputScript()
    var assetValue = new asset.AssetValue(assetdef, rawTarget.value)
    return new asset.AssetTarget(script.toHex(), assetValue)
  })

  var assetTx = new tx.AssetTx(self, assetTargets)
  Q.nfcall(tx.transformTx, assetTx, 'composed')
    .done(function (composedTx) { cb(null, composedTx) }, function (error) { cb(error) })
}

/**
 * @callback Wallet~createIssuanceTx
 * @param {?Error} error
 * @param {ComposedTx} tx
 */

/**
 * @param {string} moniker
 * @param {string} pck
 * @param {number} units
 * @param {number} atoms
 * @param {string} seedHex
 * @param {Wallet~createIssuanceTx} cb
 * @throws {Error} If wallet not initialized
 */
Wallet.prototype.createIssuanceTx = function (moniker, pck, units, atoms, seedHex, cb) {
  verify.string(moniker)
  verify.string(pck)
  verify.number(units)
  verify.number(atoms)
  verify.hexString(seedHex)
  verify.function(cb)

  this.isInitializedCheck()

  var self = this

  Q.fcall(function () {
    var colorDefinitionCls = cclib.ColorDefinitionManager.getColorDefenitionClsForType(pck)
    if (colorDefinitionCls === null) {
      throw new errors.VerifyColorDefinitionTypeError('Type: ' + pck)
    }

    var addresses = self.getAddressManager().getAllAddresses(colorDefinitionCls)
    if (addresses.length === 0) {
      addresses.push(self.getAddressManager().getNewAddress(colorDefinitionCls, seedHex))
    }

    var targetAddress = addresses[0].getAddress()
    var targetScript = bitcoin.Address.fromBase58Check(targetAddress).toOutputScript()
    var colorValue = new cclib.ColorValue(cclib.ColorDefinitionManager.getGenesis(), units * atoms)
    var colorTarget = new cclib.ColorTarget(targetScript.toHex(), colorValue)

    var operationalTx = new tx.OperationalTx(self)
    operationalTx.addTarget(colorTarget)

    return Q.nfcall(colorDefinitionCls.composeGenesisTx, operationalTx)

  }).done(function (composedTx) { cb(null, composedTx) }, function (error) { cb(error) })
}

/**
 * @callback Wallet~transformTx
 * @param {?Error} error
 * @param {(RawTx|bitcoinjs-lib.Transaction)} tx
 */

/**
 * @param {(ComposedTx|RawTx)} currentTx
 * @param {string} targetKind
 * @param {Object} [opts]
 * @param {string} [opts.seedHex]
 * @param {number[]} [opts.signingOnly]
 * @param {Wallet~transformTx} cb
 * @throws {Error} If wallet not initialized or not currently seedHex
 */
Wallet.prototype.transformTx = function (currentTx, targetKind, opts, cb) {
  if (_.isFunction(opts) && _.isUndefined(cb)) {
    cb = opts
    opts = undefined
  }
  if (_.isString(opts)) {
    console.warn('seedHex as string is deprecated for removal in 1.0.0, use Object')
    opts = {seedHex: opts}
  }

  verify.function(cb)

  this.isInitializedCheck()
  if (targetKind === 'signed') {
    this.getAddressManager().isCurrentSeedCheck(opts.seedHex)
  }

  opts = _.extend(opts, {wallet: this})
  Q.nfcall(tx.transformTx, currentTx, targetKind, opts).done(
    function (newTx) { cb(null, newTx) },
    function (error) { cb(error) }
  )
}

/**
 * @callback Wallet~sendTx
 * @param {?Error} error
 */

/**
 * @param {bitcoinjs-lib.Transaction} tx
 * @param {Wallet~sendTx} cb
 */
Wallet.prototype.sendTx = function (tx, cb) {
  verify.function(cb)

  this.getStateManager().sendTx(tx).done(function () { cb(null) }, function (error) { cb(error) })
}

/**
 */
Wallet.prototype.removeListeners = function () {
  this.removeAllListeners()
  this.network.removeAllListeners()
  this.blockchain.removeAllListeners()
  this.aManager.removeAllListeners()
  this.adManager.removeAllListeners()
  this.walletStateManager.removeAllListeners()
  this.txFetcher.removeAllListeners()
}

/**
 */
Wallet.prototype.clearStorage = function () {
  this.config.clear()
  this.blockchainStorage.clear()
  this.cdStorage.clear()
  this.cDataStorage.clear()
  this.aStorage.clear()
  this.adStorage.clear()
  this.walletStateManager.clear()
}


module.exports = Wallet
