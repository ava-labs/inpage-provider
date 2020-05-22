const pump = require('pump')
const RpcEngine = require('json-rpc-engine')
const createIdRemapMiddleware = require('json-rpc-engine/src/idRemapMiddleware')
const createJsonRpcStream = require('json-rpc-middleware-stream')
const ObjectMultiplex = require('obj-multiplex')
const SafeEventEmitter = require('safe-event-emitter')
const dequal = require('fast-deep-equal')
const { ethErrors } = require('eth-json-rpc-errors')
const log = require('loglevel')

const messages = require('./messages')
const { sendSiteMetadata } = require('./siteMetadata')
const {
  createErrorMiddleware,
  EMITTED_NOTIFICATIONS,
  getRpcPromiseCallback,
  logStreamDisconnectWarning,
  NOOP,
} = require('./utils')

module.exports = class MetamaskInpageProvider extends SafeEventEmitter {

  /**
   * @emits MetamaskInpageProvider#connect
   * @emits MetamaskInpageProvider#message
   *
   * @param {Object} connectionStream - A Node.js stream
   * @param {Object} options - An options bag
   * @param {number} [options.maxEventListeners=100] - The maximum number of event listeners
   * @param {boolean} [options.shouldSendMetadata=true] - Whether the provider should send page metadata
   */
  constructor (
    connectionStream,
    { maxEventListeners = 100, shouldSendMetadata = true } = {},
  ) {

    if (
      !connectionStream || typeof connectionStream !== 'object' ||
      typeof shouldSendMetadata !== 'boolean' ||
      typeof maxEventListeners !== 'number'
    ) {
      throw new Error('Invalid options.')
    }

    super()

    this.isMetaMask = true

    this.setMaxListeners(maxEventListeners)

    // private state
    this._state = {
      sentWarnings: {
        // methods
        enable: false,
        experimentalMethods: false,
        isConnected: false,
        send: false,
        // events
        events: {
          chainIdChanged: false,
          close: false,
          networkChanged: false,
          notification: false,
        },
        // misc
        // TODO:deprecation:remove
        autoReload: false,
      },
      isConnected: null,
      accounts: null,
      isUnlocked: false,
    }

    this._metamask = this._getExperimentalApi()

    // public state
    this.selectedAddress = null
    this.networkVersion = null
    this.chainId = null

    // bind functions (to prevent e.g. web3@1.x from making unbound calls)
    this._handleAccountsChanged = this._handleAccountsChanged.bind(this)
    this._handleChainChanged = this._handleChainChanged.bind(this)
    this._handleUnlockStateChanged = this._handleUnlockStateChanged.bind(this)
    this._handleDisconnect = this._handleDisconnect.bind(this)
    this._sendSync = this._sendSync.bind(this)
    this._rpcRequest = this._rpcRequest.bind(this)
    this._warnOfDeprecation = this._warnOfDeprecation.bind(this)
    this.enable = this.enable.bind(this)
    this.request = this.request.bind(this)
    this.send = this.send.bind(this)
    this.sendAsync = this.sendAsync.bind(this)

    // setup connectionStream multiplexing
    const mux = new ObjectMultiplex()
    pump(
      connectionStream,
      mux,
      connectionStream,
      this._handleDisconnect.bind(this, 'MetaMask'),
    )

    // ignore phishing warning message (handled elsewhere)
    mux.ignoreStream('phishing')

    // setup own event listeners

    // EIP-1193 connect
    this.on('connect', () => {
      this._state.isConnected = true
    })

    // setup RPC connection

    const jsonRpcConnection = createJsonRpcStream()
    pump(
      jsonRpcConnection.stream,
      mux.createStream('provider'),
      jsonRpcConnection.stream,
      this._handleDisconnect.bind(this, 'MetaMask RpcProvider'),
    )

    // handle RPC requests via dapp-side rpc engine
    const rpcEngine = new RpcEngine()
    rpcEngine.push(createIdRemapMiddleware())
    rpcEngine.push(createErrorMiddleware())
    rpcEngine.push(jsonRpcConnection.middleware)
    this._rpcEngine = rpcEngine

    // handle JSON RPC notifications
    jsonRpcConnection.events.on('notification', (payload) => {
      if (payload.method === 'wallet_accountsChanged') {
        this._handleAccountsChanged(payload.result)
      } else if (payload.method === 'wallet_unlockStateChanged') {
        this._handleUnlockStateChanged(payload.result)
      } else if (payload.method === 'wallet_chainChanged') {
        this._handleChainChanged(payload.result)
      } else if (EMITTED_NOTIFICATIONS.includes(payload.method)) {
        this.emit('notification', payload) // deprecated
        this.emit('message', {
          type: payload.method,
          data: payload.params,
        })
      }
    })

    // get initial state
    this.request({ method: 'wallet_getProviderState' })
      .then((state) => {
        const {
          chainId,
          networkVersion,
          isUnlocked,
          accounts,
        } = state

        this._handleChainChanged({ chainId, networkVersion })
        this._handleAccountsChanged(accounts)
        this._handleUnlockStateChanged(isUnlocked)

        // indicate that we've connected, for EIP-1193 compliance
        this.emit('connect', { chainId: this.chainId })
      })
      .catch((error) => {
        log.error(
          'MetaMask: Failed to get initial state. Please report this bug.',
          error,
        )
      })

    // miscellanea

    // send website metadata
    if (shouldSendMetadata) {
      const domContentLoadedHandler = () => {
        sendSiteMetadata(this._rpcEngine)
        window.removeEventListener('DOMContentLoaded', domContentLoadedHandler)
      }
      window.addEventListener('DOMContentLoaded', domContentLoadedHandler)
    }

    // TODO:deprecation:remove
    this._web3Ref = undefined

    // TODO:deprecation:remove
    // give the dapps control of a refresh they can toggle this off on the window.ethereum
    // this will be default true so it does not break any old apps.
    this.autoRefreshOnNetworkChange = true

    // TODO:deprecation:remove
    // wait a second to attempt to send this, so that the warning can be silenced
    // moved this here because there's another warning in .enable() discouraging
    // the use thereof per EIP 1102
    setTimeout(() => {
      if (this.autoRefreshOnNetworkChange && !this._state.sentWarnings.autoReload) {
        log.warn(messages.warnings.autoReloadDeprecation)
        this._state.sentWarnings.autoReload = true
      }
    }, 1000)
  }

  //====================
  // Public Methods
  //====================

  /**
   * Experimental. The signature of this method may change without warning, pending EIP 1193.
   *
   * Submits an RPC request to MetaMask for the given method, with the given params.
   * Resolves with the result of the method call, or rejects on error.
   *
   * @param {Object} args - The RPC request arguments.
   * @param {string} args.method - The RPC method name.
   * @param {unknown} [args.params] - The parameters for the RPC method.
   * @returns {Promise<unknown>} A Promise that resolves with the result of the RPC method,
   * or rejects if an error is encountered.
   */
  async request (args) {

    if (typeof args !== 'object' || Array.isArray(args)) {
      throw ethErrors.rpc.invalidRequest({
        message: `Expected a single, non-array, object argument.`,
        data: args,
      })
    }

    const { method, params } = args

    if (typeof method !== 'string' || !method) {
      throw ethErrors.rpc.invalidRequest({
        message: `'args.method' must be a non-empty string`,
        data: args,
      })
    }

    return new Promise((resolve, reject) => {
      this._rpcRequest(
        { method, params },
        getRpcPromiseCallback(resolve, reject),
      )
    })
  }

  /**
   * Submit a JSON-RPC request object and a callback to make an RPC method call.
   *
   * @param {Object} payload - The RPC request object.
   * @param {Function} callback - The callback function.
   */
  sendAsync (payload, cb) {
    this._rpcRequest(payload, cb)
  }

  /**
   * We override the following event methods so that we can warn consumers
   * about deprecated events:
   *   addListener, on, once, prependListener, prependOnceListener
   */

  /**
   * @inheritdoc
   */
  addListener (eventName, listener) {
    this._warnOfDeprecation(eventName)
    return super.addListener(eventName, listener)
  }

  /**
   * @inheritdoc
   */
  on (eventName, listener) {
    this._warnOfDeprecation(eventName)
    return super.on(eventName, listener)
  }

  /**
   * @inheritdoc
   */
  once (eventName, listener) {
    this._warnOfDeprecation(eventName)
    return super.once(eventName, listener)
  }

  /**
   * @inheritdoc
   */
  prependListener (eventName, listener) {
    this._warnOfDeprecation(eventName)
    return super.prependListener(eventName, listener)
  }

  /**
   * @inheritdoc
   */
  prependOnceListener (eventName, listener) {
    this._warnOfDeprecation(eventName)
    return super.prependOnceListener(eventName, listener)
  }

  //====================
  // Private Methods
  //====================

  /**
   * Internal RPC method. Forwards requests to background via the RPC engine.
   * Also remap ids inbound and outbound.
   *
   * @param {Object} payload - The RPC request object.
   * @param {Function} callback - The consumer's callback.
   * @param {boolean} isInternal - Whether the request is internal.
   */
  _rpcRequest (payload, callback, isInternal = false) {

    let cb = callback

    if (!Array.isArray(payload)) {

      if (!payload.jsonrpc) {
        payload.jsonrpc = '2.0'
      }

      if (
        payload.method === 'eth_accounts' ||
        payload.method === 'eth_requestAccounts'
      ) {

        // handle accounts changing
        cb = (err, res) => {
          this._handleAccountsChanged(
            res.result || [],
            payload.method === 'eth_accounts',
            isInternal,
          )
          callback(err, res)
        }
      }
    }
    this._rpcEngine.handle(payload, cb)
  }

  /**
   * Called when connection is lost to critical streams.
   * @emits MetamaskInpageProvider#disconnect
   */
  _handleDisconnect (streamName, err) {

    logStreamDisconnectWarning.bind(this)(streamName, err)

    const disconnectError = {
      code: 1011,
      reason: messages.errors.disconnected(),
    }

    if (this._state.isConnected) {
      this.emit('disconnect', disconnectError)
      this.emit('close', disconnectError) // deprecated
    }
    this._state.isConnected = false
  }

  /**
   * Called when accounts may have changed.
   * @emits MetamaskInpageProvider#accountsChanged
   */
  _handleAccountsChanged (accounts, isEthAccounts = false, isInternal = false) {

    let _accounts = accounts

    // defensive programming
    if (!Array.isArray(accounts)) {
      log.error(
        'MetaMask: Received invalid accounts parameter. Please report this bug.',
        accounts,
      )
      _accounts = []
    }

    // emit accountsChanged if anything about the accounts array has changed
    if (!dequal(this._state.accounts, _accounts)) {

      // we should always have the correct accounts even before eth_accounts
      // returns, except in cases where isInternal is true
      if (isEthAccounts && this._state.accounts !== null && !isInternal) {
        log.error(
          `MetaMask: 'eth_accounts' unexpectedly updated accounts. Please report this bug.`,
          _accounts,
        )
      }

      this._state.accounts = _accounts
      this.emit('accountsChanged', _accounts)
    }

    // handle selectedAddress
    if (this.selectedAddress !== _accounts[0]) {
      this.selectedAddress = _accounts[0] || null
    }

    // TODO:deprecation:remove
    // handle web3
    if (this._web3Ref) {
      this._web3Ref.defaultAccount = this.selectedAddress
    } else if (
      window.web3 &&
      window.web3.eth &&
      typeof window.web3.eth === 'object'
    ) {
      window.web3.eth.defaultAccount = this.selectedAddress
    }
  }

  /**
   * Upon receipt of a new chainId and networkVersion, emits corresponding
   * events and sets relevant public state.
   * Does nothing if neither the chainId nor the networkVersion are different
   * from existing values.
   *
   * @emits MetamaskInpageProvider#chainChanged
   *
   * @param {Object} networkInfo - An object with network info.
   * @param {string} networkInfo.chainId - The latest chain ID.
   * @param {string} networkInfo.networkVersion - The latest network ID.
   */
  _handleChainChanged ({ chainId, networkVersion } = {}) {

    if (
      typeof chainId !== 'string' || !chainId.startsWith('0x') ||
      typeof networkVersion !== 'string'
    ) {
      log.error(
        'MetaMask: Received invalid network parameters. Please report this bug.',
        { chainId, networkVersion },
      )
      return
    }

    if (chainId !== this.chainId || networkVersion !== this.networkVersion) {
      this.chainId = chainId
      this.emit('chainChanged', this.chainId)
      this.emit('chainIdChanged', this.chainId) // TODO:deprecation:remove

      this.networkVersion = networkVersion
      this.emit('networkChanged', this.networkVersion)
    }
  }

  /**
   * Upon receipt of a new isUnlocked state, emits the corresponding event
   * and sets relevant public state.
   * Does nothing if the received value is equal to the existing value.
   *
   * @param {boolean} isUnlocked - The latest isUnlocked value.
   */
  _handleUnlockStateChanged (isUnlocked) {

    if (typeof isUnlocked !== 'boolean') {
      log.error('MetaMask: Received invalid isUnlocked parameter. Please report this bug.')
      return
    }

    if (isUnlocked !== this._state.isUnlocked) {

      this._state.isUnlocked = isUnlocked

      if (isUnlocked) {

        // this will get the exposed accounts, if any
        try {
          this._rpcRequest(
            { method: 'eth_accounts', params: [] },
            NOOP,
            true, // indicating that eth_accounts _should_ update accounts
          )
        } catch (_) { /* no-op */ }
      } else {
        // accounts are never exposed when the extension is locked
        this._handleAccountsChanged([])
      }
    }
  }

  /**
   * Warns of deprecation for the given event, if applicable.
   */
  _warnOfDeprecation (eventName) {
    if (this._state.sentWarnings.events[eventName] === false) {
      console.warn(messages.warnings.events[eventName])
      this._state.sentWarnings.events[eventName] = true
    }
  }

  /**
   * Constructor helper.
   * Gets experimental _metamask API as Proxy, so that we can warn consumers
   * about its experiment nature.
   */
  _getExperimentalApi () {

    return new Proxy(
      {

        /**
         * Determines if MetaMask is unlocked by the user.
         *
         * @returns {Promise<boolean>} - Promise resolving to true if MetaMask is currently unlocked
         */
        isUnlocked: async () => {
          return this._state.isUnlocked
        },

        /**
         * Make a batch RPC request.
         */
        requestBatch: async (requests) => {

          if (!Array.isArray(requests)) {
            throw ethErrors.rpc.invalidRequest({
              message: 'Batch requests must be made with an array of request objects.',
              data: requests,
            })
          }

          return new Promise((resolve, reject) => {
            this._rpcRequest(
              requests,
              getRpcPromiseCallback(resolve, reject),
            )
          })
        },

        // TODO:deprecation:remove isEnabled, isApproved
        /**
         * DEPRECATED. To be removed.
         * Synchronously determines if this domain is currently enabled, with a potential false negative if called to soon
         *
         * @returns {boolean} - returns true if this domain is currently enabled
         */
        isEnabled: () => {
          return Array.isArray(this._state.accounts) && this._state.accounts.length > 0
        },

        /**
         * DEPRECATED. To be removed.
         * Asynchronously determines if this domain is currently enabled
         *
         * @returns {Promise<boolean>} - Promise resolving to true if this domain is currently enabled
         */
        isApproved: async () => {
          if (this._state.accounts === null) {
            await new Promise(
              (resolve) => this.once('accountsChanged', () => resolve()),
            )
          }
          return Array.isArray(this._state.accounts) && this._state.accounts.length > 0
        },
      },
      {
        get: (obj, prop) => {

          if (!this._state.sentWarnings.experimentalMethods) {
            log.warn(messages.warnings.experimentalMethods)
            this._state.sentWarnings.experimentalMethods = true
          }
          return obj[prop]
        },
      },
    )
  }

  //====================
  // Deprecated Methods
  //====================

  /**
   * DEPRECATED.
   * Returns whether the inpage provider is connected to MetaMask.
   */
  isConnected () {

    if (!this._state.sentWarnings.isConnected) {
      log.warn(messages.warnings.isConnectedDeprecation)
      this._state.sentWarnings.isConnected = true
    }
    return this._state.isConnected
  }

  /**
   * DEPRECATED.
   * Equivalent to: ethereum.request('eth_requestAccounts')
   *
   * @returns {Promise<Array<string>>} - A promise that resolves to an array of addresses.
   */
  enable () {

    if (!this._state.sentWarnings.enable) {
      log.warn(messages.warnings.enableDeprecation)
      this._state.sentWarnings.enable = true
    }

    return new Promise((resolve, reject) => {
      try {
        this._rpcRequest(
          { method: 'eth_requestAccounts', params: [] },
          getRpcPromiseCallback(resolve, reject),
        )
      } catch (error) {
        reject(error)
      }
    })
  }

  /**
   * DEPRECATED.
   * Sends an RPC request to MetaMask.
   * Many different return types, which is why this method should not be used.
   *
   * @param {(string | Object)} methodOrPayload - The method name, or the RPC request object.
   * @param {Array<any> | Function} [callbackOrArgs] - If given a method name, the method's parameters.
   * @returns {unknown} - The method result, or a JSON RPC response object.
   */
  send (methodOrPayload, callbackOrArgs) {

    if (!this._state.sentWarnings.send) {
      log.warn(messages.warnings.sendDeprecation)
      this._state.sentWarnings.send = true
    }

    if (
      typeof methodOrPayload === 'string' &&
      (!callbackOrArgs || Array.isArray(callbackOrArgs))
    ) {
      return new Promise((resolve, reject) => {
        try {
          this._rpcRequest(
            { method: methodOrPayload, params: callbackOrArgs },
            getRpcPromiseCallback(resolve, reject, false),
          )
        } catch (error) {
          reject(error)
        }
      })
    } else if (
      typeof methodOrPayload === 'object' &&
      typeof callbackOrArgs === 'function'
    ) {
      return this._rpcRequest(methodOrPayload, callbackOrArgs)
    }
    return this._sendSync(methodOrPayload)
  }

  /**
   * DEPRECATED.
   * Internal backwards compatibility method, used in send.
   */
  _sendSync (payload) {

    let result
    switch (payload.method) {

      case 'eth_accounts':
        result = this.selectedAddress ? [this.selectedAddress] : []
        break

      case 'eth_coinbase':
        result = this.selectedAddress || null
        break

      case 'eth_uninstallFilter':
        this._rpcRequest(payload, NOOP)
        result = true
        break

      case 'net_version':
        result = this.networkVersion || null
        break

      default:
        throw new Error(messages.errors.unsupportedSync(payload.method))
    }

    return {
      id: payload.id,
      jsonrpc: payload.jsonrpc,
      result,
    }
  }
}
