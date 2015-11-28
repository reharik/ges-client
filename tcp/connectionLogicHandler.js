var tcpPackageConnection = require('./tcpPackageConnection')
	, operationsManager = require('./operationsManager')
	, operations = require ('./operations')
	, inspection = operations.inspection
	, subscriptionsManager = require('./subscriptionsManager')
	, subscriptionOperation = require('./operations/subscriptionOperation')
	, createQueue = require('./simpleQueuedHandler')
	, messages = require('./messages')
	, ensure = require('../ensure')
	, util = require('util')
	, EventEmitter = require('events').EventEmitter
	, uuid = require('node-uuid')
	, Stopwatch = require('statman-stopwatch')
	, getIsoDate = require('./getIsoDate')
	, dateDiff = require('./isoDateDiff')


function LogDebug(message) {
	//console.log(message)
}

function LogInfo(message) {
	//console.log(message)
}

module.exports = EsConnectionLogicHandler


function noOp(message, cb) {
	cb && cb(null)
}	

function EsConnectionLogicHandler(esConnection, connectionSettings) {
	if(!(this instanceof EsConnectionLogicHandler)) {
		return new EsConnectionLogicHandler(esConnection, connectionSettings)
	}

	EventEmitter.call(this)

	var me = this

	this._queue = createQueue()
	this._stopwatch = new Stopwatch(true)

	this._queue.registerHandler('StartConnection', function(msg) { me._startConnection(msg.endpointDiscoverer, msg.cb) })
	this._queue.registerHandler('CloseConnection', function(msg) { me._closeConnection(msg.reason, msg.exception) })

	this._queue.registerHandler('StartOperation', function(msg) {
		me._startOperation(msg.operation, msg.maxRetries, msg.timeout)
	})
	this._queue.registerHandler('StartSubscription', function(msg) { me._startSubscription(msg) })

	this._queue.registerHandler('EstablishTcpConnection', function(msg) { me._establishTcpConnection(msg.endpoints) })
	this._queue.registerHandler('TcpConnectionEstablished', function(msg) { me._tcpConnectionEstablished(msg.connection) })
	this._queue.registerHandler('TcpConnectionError', function(msg) { 
		me._tcpConnectionError(msg.connection, message.exception)
	})
	this._queue.registerHandler('TcpConnectionClosed', function(msg) { me._tcpConnectionClosed(msg.connection) })
	this._queue.registerHandler('HandleTcpPackage', function(msg) { me._handleTcpPackage(msg.connection, msg.package) })

	this._queue.registerHandler('TimerTick', function(msg) { me._timerTick() })

	Object.defineProperty(this, '_settings', { value: connectionSettings })

	this._handlers = {}

	this._esConnection = esConnection
	this._tcpConnection = null
	this._endPoint = null
	this._state = null

	this._queuedMessages = []
	this._operations = operationsManager(this._esConnection.connectionName, this._settings)
	this._subscriptions = subscriptionsManager()

	this._tcpConnectionState = 'Init'
	this._connectingPhase = connectingPhase.Invalid
	this._wasConnected = false
	this._packageNumber = 0


	this._timer = setInterval(function() {
		me.enqueueMessage({
			type: 'TimerTick'
		})
	}, 200)
}
util.inherits(EsConnectionLogicHandler, EventEmitter)


EsConnectionLogicHandler.prototype.enqueueMessage = function(message) {
	this._queue.enqueueMessage(message)
}

EsConnectionLogicHandler.prototype.isInState = function(state) {
	return this._tcpConnectionState === state
}

EsConnectionLogicHandler.prototype._closeConnection = function(reason, exception) {
	LogDebug('In close connection handler')
	this._getStateMessageHandler(closeConnectionHandlers)
		.call(this, reason, exception)
}

EsConnectionLogicHandler.prototype._closeTcpConnection = function(reason) {
	if(this._tcpConnection === null) {
    LogDebug('CloseTcpConnection IGNORED because _tcpConnection is null');
    return
  }

  LogDebug('CloseTcpConnection')

	var me = this

	this._tcpConnection.close(reason, function(err) {
		me._tcpConnectionClosed(me._tcpConnection)
		me._tcpConnection.cleanup()
		me._tcpConnection = null
	})
}

EsConnectionLogicHandler.prototype._discoverEndpoint = function(cb) {
	cb = cb || noOp

	if(this._tcpConnectionState !== 'Connecting') return cb()
	if(this._connectingPhase !== connectingPhase.Reconnecting) return cb()

	this._connectingPhase = connectingPhase.EndpointDiscovery
	
	var existingEndpoint = this._tcpConnection !== null ? this._tcpConnection.remoteEndpoint : null
		, me = this

	this._endpointDiscoverer.discover(existingEndpoint, function(err, endpoint) {
		if(err) {
			me.enqueueMessage(messages.closeConnection('Failed to resolve TCP endpoint', err))
			var error = new Error("Couldn't resolve target endpoint.")
			error.inner = err
			cb(error)
		} else {
			me.enqueueMessage(messages.establishTcpConnection(endpoint))
			cb()
		}
	})
}

EsConnectionLogicHandler.prototype._establishTcpConnection = function(endpoints) {
	var endpoint = endpoints.tcpEndpoint
	if(endpoint === null) {
		this._closeConnection('No endpoint to node specified.')
		return
	}

	//TODO: 
	LogDebug('EstablishTcpConnection to [' + endpoint.host + ':' + endpoint.port + ']')

	if(this._tcpConnectionState !== 'Connecting') return
	if(this._connectingPhase !== connectingPhase.EndpointDiscovery) return

	this._connectingPhase = connectingPhase.ConnectionEstablishing

	var me = this
		, connection = tcpPackageConnection({
				endPoint: endpoint
			})

	connection.on('connect', function() {
		me.enqueueMessage(messages.tcpConnectionEstablished(connection))
	})

	connection.on('package', function(data) {
		me.enqueueMessage(messages.handleTcpPackage(data.connection, data.package))
	})

	connection.on('error', function(err) {
		me.enqueueMessage(messages.tcpConnectionError(connection, err))
	})

	connection.on('close', function() {
		me.enqueueMessage(messages.tcpConnectionClosed(connection))
	})

	this._tcpConnection = connection
}

EsConnectionLogicHandler.prototype._getStateMessageHandler = function(stateMessages) {
	ensure.exists(stateMessages, 'stateMessages')

	var handler = stateMessages[this._tcpConnectionState]
	if(!handler) {
		throw new Error('Unknown stage: ' + this._tcpConnectionState)
	}
	return handler
}

EsConnectionLogicHandler.prototype._handleTcpPackage = function(connection, package) {
	this._getStateMessageHandler(handleTcpPackageHandlers)
		.call(this, connection, package)
}

EsConnectionLogicHandler.prototype._goToConnectedState = function() {
	ensure.exists(this._tcpConnection, 'connection');

  this._tcpConnectionState = 'Connected'
  this._connectingPhase = connectingPhase.Connected

  this._wasConnected = true

  this.emit('connect', this._tcpConnection.remoteEndpoint)

/*
  if(this._stopwatch.read() - this._lastTimeoutsTimeStamp >= _settings.OperationTimeoutCheckPeriod) {
    this._operations.CheckTimeoutsAndRetry(_tcpConnection)
    this._subscriptions.CheckTimeoutsAndRetry(_tcpConnection)
    this._lastTimeoutsTimeStamp = this._stopwatch.read()
  }
*/
}

EsConnectionLogicHandler.prototype._isInPhase = function(connectingPhase) {
	return this._connectingPhase === connectingPhase
}

EsConnectionLogicHandler.prototype._manageHeartbeats = function() {
	if(this._tcpConnection === null) throw new Error('Trying to process heartbeat message when connection is null.')

  var timeout = 2000 //this._heartbeatInfo.IsIntervalStage ? this._settings.HeartbeatInterval : this._settings.HeartbeatTimeout
  if(this._stopwatch.read() - this._heartbeatInfo.TimeStamp < timeout) return

  var packageNumber = this._packageNumber
  if(this._heartbeatInfo.LastPackageNumber !== packageNumber) {
    this._heartbeatInfo = new HeartbeatInfo(packageNumber, true, this._stopwatch.read())
    return
  }

  if(this._heartbeatInfo.IsIntervalStage) {
    // TcpMessage.Heartbeat analog
    this._tcpConnection.enqueueSend({
			messageName: 'HeartbeatRequestCommand'
		, correlationId: uuid.v4()
		})
    this._heartbeatInfo = new HeartbeatInfo(this._heartbeatInfo.LastPackageNumber, false, this._stopwatch.read())
  } else {
    var message = 'EventStoreConnection "' + this._esConnection.connectionName
    	+ '": closing TCP connection [' + this._tcpConnection.remoteEndpoint
    	+ ', ' + this._tcpConnection.localEndpoint
    	+ ', ' + this._tcpConnection.connectionId
    	+ '] due to HEARTBEAT TIMEOUT at pkgNum ' + packageNumber
    	+ '.'
    LogInfo(message)

    this._closeTcpConnection(message)
	} 
}

EsConnectionLogicHandler.prototype._raiseAuthenticationFailed = function(reason) {
	this.emit('authentication failed', {
		esConnection: this._esConnection
	, reason: reason
	})
}

EsConnectionLogicHandler.prototype._startConnection = function(endpointDiscoverer, cb) {
	this._getStateMessageHandler(startConnectionHandlers)
		.call(this, endpointDiscoverer, cb)
}

EsConnectionLogicHandler.prototype._startOperation = function(operation, maxRetries, timeout) {
	this._getStateMessageHandler(startOperationHandlers)
		.call(this, operation, maxRetries, timeout)
}

EsConnectionLogicHandler.prototype._startSubscription = function(message) {
	this._getStateMessageHandler(startSubscriptionHandlers).call(this, message)
}

EsConnectionLogicHandler.prototype._tcpConnectionClosed = function(connection) {
	if(this._tcpConnectionState === 'Init') throw new Error()
  if(this._tcpConnectionState === 'Closed' || this._tcpConnection !== connection) {
  	/* TODO: */
      LogDebug('IGNORED (_state: {0}, _conn.ID: {1:B}, conn.ID: {2:B}): TCP connection to [{3}, L{4}] closed.', 
               this._tcpConnectionState, this._tcpConnection.ConnectionId, connection.ConnectionId, 
               connection.RemoteEndPoint, connection.LocalEndPoint)
    
    return
  }

  this._tcpConnectionState = 'Connecting'
  this._connectingPhase = connectingPhase.Reconnecting

  //TODO: 
  LogDebug('TCP connection to [{0}, L{1}, {2:B}] closed.', connection.RemoteEndPoint, connection.LocalEndPoint, connection.ConnectionId);

  this._subscriptions.purgeSubscribedAndDroppedSubscriptions(this._tcpConnection.connectionId)
  this._reconnInfo = new ReconnectionInfo()

  if(this._wasConnected) {
  	this._wasConnected = false
    this.emit('disconnected', connection.remoteEndPoint)
  }
}

EsConnectionLogicHandler.prototype._tcpConnectionError = function(tcpConnection, err) {
	if(tcpConnection !== this._tcpConnection) return
  if(this._tcpConnectionState === 'Closed') return

  LogDebug('TcpConnectionError connId ' + tcpConnection.connectionId
  	+ ', exc ' + err.message
  	+ '.'
	)
  this.closeConnection('TCP connection error occurred.', err);
}

EsConnectionLogicHandler.prototype._tcpConnectionEstablished = function(connection) {
	if(this._tcpConnectionState !== 'Connecting' || this._tcpConnection !== connection || connection.isClosed) {
		/* TODO: */
    LogDebug('IGNORED (_state {0}, _conn.Id {1:B}, conn.Id {2:B}, conn.closed {3}): TCP connection to [{4}, L{5}] established.', 
    	this._tcpConnectionState, this._tcpConnection.ConnectionId, connection.ConnectionId, 
     	connection.IsClosed, connection.RemoteEndPoint, connection.LocalEndPoint);
    
    return
  }

  //TODO:
  LogDebug('TCP connection to [{0}, L{1}, {2:B}] established.', connection.RemoteEndPoint, connection.LocalEndPoint, connection.ConnectionId);
  this._heartbeatInfo = new HeartbeatInfo(this._packageNumber, true, this._stopwatch.read());

  if(this._settings.defaultUserCredentials) {
    this._connectingPhase = connectingPhase.Authentication;
    this._authInfo = new AuthInfo()

    this._tcpConnection.enqueueSend({
    	messageName: 'Authenticate'
  	, correlationId: this._authInfo.correlationId
  	, auth: this._settings.defaultUserCredentials
	  })
  } else {
    this._goToConnectedState();
  }
}

EsConnectionLogicHandler.prototype._timerTick = function() {
	this._getStateMessageHandler(timerTickHandlers).call(this)
}

var noOp = function() {}

var closeConnectionHandlers = {
			Init: performCloseConnection
		, Connecting: performCloseConnection
		, Connected: performCloseConnection
		, Closed: function(reason, err) {
				LogDebug('CloseConnection IGNORED because is ESConnection is CLOSED, reason ' + reason
					+ ', exception ' + (err && err.message) || err || '<no error>'
					+ '.')
			}
		}

function performCloseConnection(reason, err) {
	LogDebug('CloseConnection, reason ' + reason + ', exception ' + err + '.');

	this._tcpConnectionState = 'Closed'

	clearInterval(this._timer)
	this._operations.cleanUp()
	this._subscriptions.cleanUp()
	this._closeTcpConnection(reason)

	LogInfo('Closed. Reason: {0}.', reason)

	if(err) {
		this.emit('error', err)
	}

	this._esConnection.emitClose(reason)
}

var handleTcpPackageHandlers = {
			Init: noOp
		, Connecting: handleTcpPackage
		, Connected: handleTcpPackage
		, Closed: noOp
		}

function handleTcpPackage(connection, package) {
	var handleMessage = 'HandleTcpPackage connId ' + this._tcpConnection.connectionId
    	+ ', package ' + package.messageName
    	+ ', ' + package.correlationId
    	+ '.'
	if(this._tcpConnection !== connection || this._tcpConnectionState === 'Closed' || this._tcpConnectionState === 'Init') {
    LogDebug('IGNORED: ' + handleMessage)
    return
  }
            
  LogDebug(handleMessage)
  this._packageNumber += 1

  if(package.messageName === 'HeartbeatResponseCommand') return
  if(package.messageName === 'HeartbeatRequestCommand') {
    this._tcpConnection.enqueueSend({
    	messageName: 'HeartbeatResponseCommand'
  	, correlationId: package.correlationId
	  })
    return
  }

  if(package.messageName === 'Authenticated' || package.messageName === 'NotAuthenticated') {
    if(this._tcpConnectionState === 'Connecting'
    && this._connectingPhase === connectingPhase.Authentication
    && this._authInfo.correlationId === package.correlationId) {
      if(package.messageName === 'NotAuthenticated') {
        this._raiseAuthenticationFailed('Not authenticated')
      }

      this._goToConnectedState()
      return
    }
  }

  //BLM: Investigate if correlationId will be undefined or empty
  if(package.messageName === 'BadRequest' && package.correlationId === '00000000-0000-0000-0000-000000000000') {
    var message = '<no message>'
    try {
    	package.payload.toString('UTF8') 
    }
    catch(e) {
    	message = (e && e.message) || message
    }

    var err = new Error('Bad request received from server. Error: ' + message)
    this._closeConnection('Connection-wide BadRequest received. Too dangerous to continue.', exc)
    return
  }

  var operationItem = this._operations.getActiveOperation(package.correlationId)
  	, subscriptionItem = this._subscriptions.getActiveSubscription(package.correlationId)

  if(operationItem) {
    var result = operationItem.operation.inspectPackage(package)
    LogDebug('HandleTcpPackage OPERATION DECISION ' + result.decision + ' (' + result.description + '), '
    	+ operationItem.toString())
    switch (result.decision) {
      case inspection.decision.DoNothing: break
      case inspection.decision.EndOperation: 
        this._operations.removeOperation(operationItem)
        break;
      case inspection.decision.Retry: 
        _operations.scheduleOperationRetry(operation)
        break;
      case inspection.decision.Reconnect:
        ReconnectTo(new NodeEndPoints(result.TcpEndPoint, result.SecureTcpEndPoint))
        _operations.scheduleOperationRetry(operation)
        break;
      default: throw new Exception(string.Format('Unknown inspection.decision: {0}', result.Decision))
    }

    if(this._tcpConnectionState === 'Connected') {
      this._operations.scheduleWaitingOperations(connection);
    }
  } else if(subscriptionItem) {
    var result = subscriptionItem.operation.inspectPackage(package)
    LogDebug('HandleTcpPackage SUBSCRIPTION DECISION ' + result.decision
    	+ ' (' + result.description
  		+ '), ' + subscriptionItem.toString())

    switch(result.decision) {
      case inspection.decision.DoNothing: break
      case inspection.decision.EndOperation: 
        this._subscriptions.removeSubscription(subscriptionItem);
        break
      case inspection.decision.Retry: 
        this._subscriptions.scheduleSubscriptionRetry(subscriptionItem);
        break
      case inspection.decision.Reconnect:
        ReconnectTo(new NodeEndPoints(result.TcpEndPoint, result.SecureTcpEndPoint))
        this._subscriptions.scheduleSubscriptionRetry(subscriptionItem)
        break
      case inspection.decision.Subscribed:
        subscriptionItem.isSubscribed = true
        break
      default: throw new Exception(string.Format('Unknown inspection.decision: {0}', result.Decision))
    }
  } else {
    LogDebug('HandleTcpPackage UNMAPPED PACKAGE with CorrelationId {0:B}, Command: {1}', package.CorrelationId, package.Command);
  }
}

var startConnectionHandlers = {
			Init: function(endpointDiscoverer, cb) {
				this._endpointDiscoverer = endpointDiscoverer
				this._tcpConnectionState = 'Connecting'
				this._connectingPhase = connectingPhase.Reconnecting
				this._discoverEndpoint(cb)
			}
		, Connecting: noOp
		, Connected: noOp
		, Closed: noOp
		}

var startOperationHandlers = {
			Init: function(operation, maxRetries, timeout) {
				operation.fail(new Error('EventStoreConnection is not active.'))
			}
		, Connecting: function(operation, maxRetries, timeout) {
				LogDebug('StartOperation enqueue ' + operation.toString() + ', ' + maxRetries + ', ' + timeout + '.')
				this._operations.enqueueOperation(operationsManager.item(operation, maxRetries, timeout, this._operations), function() { console.log(arguments)})
			}
		, Connected: function(operation, maxRetries, timeout) {
				LogDebug('StartOperation schedule ' + operation.toString() + ', ' + maxRetries + ', ' + timeout + '.')
				this._operations.scheduleOperation(operationsManager.item(operation, maxRetries, timeout, this._operations), this._tcpConnection)
			}
		, Closed: function(operation, maxRetries, timeout) {
				operation.fail(new Error('EventStoreConnection has been closed ', this._esConnection.connectionName))
			}
		}

function createSubscriptionItem(message) {
  var me = this
  	, operation = subscriptionOperation(message, function() { return me._tcpConnection })
  return subscriptionsManager.item(operation, message.maxRetries, message.timeout)
}

var startSubscriptionHandlers = {
			Init: function(message) {
				message.subscription.subscription.fail(new Error('Connection is not active ' + this._esConnection.connectionName))
			}
		, Connecting: function(message) {
				var item = createSubscriptionItem.call(this, message)
				LogDebug('StartSubscription enqueue '
					+ ', ' + message.subscription
					+ ', ' + message.maxRetries
					+ ', ' + message.timeout
					+ '.')
				this._subscriptions.enqueueSubscription(item)
			}
		, Connected: function(message) {
				var item = createSubscriptionItem.call(this, message)
				LogDebug('StartSubscription fire '
					+ ', ' + message.subscription
					+ ', ' + message.maxRetries
					+ ', ' + message.timeout
					+ '.')
				this._subscriptions.startSubscription(item, this._tcpConnection)
			}
		, Closed: function(message) {
				var err = new Error('EventStoreConnection has been closed ' + this._esConnection.connectionName)
				message.subscription.subscription.fail(err)
			}
		}

var timerTickHandlers = {
			Init: noOp
		, Connecting: function() {
      	if(this._connectingPhase === connectingPhase.Reconnecting
    		&& dateDiff(this._reconnInfo.timeStamp) >= this._settings.reconnectionDelay) {
      		LogDebug('TimerTick checking reconnection...')

      		this._reconnInfo = this._reconnInfo.nextRetry()
      		if(this._settings.maxReconnections >= 0 && this._reconnInfo.reconnectionAttempt > this._settings.maxReconnections) {
      			this.closeConnection('Reconnection limit reached.')
      		} else {
      			this.emit('reconnecting', this_esConnection)
      			this._discoverEndpoint()
      		}
      	}

      	if(this._connectingPhase === connectingPhase.Authentication
    		&& dateDiff(this._authInfo.timeStamp) > this._settings.operationTimeout) {
      		this._raiseAuthenticationFailed('Authentication timed out.')
    			this._goToConnectedState()
      	}

	      if(this._connectingPhase > connectingPhase.ConnectionEstablishing) {
	        this._manageHeartbeats()
	      }
			}
		, Connected: function() {
			/* TODO:
				// operations timeouts are checked only if connection is established and check period time passed
        if (this._stopwatch.read() - _lastTimeoutsTimeStamp >= _settings.OperationTimeoutCheckPeriod) {
          // On mono even impossible connection first says that it is established
          // so clearing of reconnection count on ConnectionEstablished event causes infinite reconnections.
          // So we reset reconnection count to zero on each timeout check period when connection is established
          _reconnInfo = new ReconnectionInfo(0, this._stopwatch.read())
          _operations.CheckTimeoutsAndRetry(_tcpConnection)
          _subscriptions.CheckTimeoutsAndRetry(_tcpConnection)
          _lastTimeoutsTimeStamp = this._stopwatch.read()
        }
        */
        this._manageHeartbeats()
			}
		, Closed: noOp
		}


var connectingPhase = {
	Invalid: 0
, Reconnecting: 1
, EndpointDiscovery: 2
, ConnectionEstablishing: 3
, Authentication: 4
, Connected: 5
}


function AuthInfo(args) {
	var id = !!args ? args.correlationId : uuid.v4()
		, ts = !!args ? args.timeStamp : getIsoDate()
	Object.defineProperty(this, 'correlationId', { value: id })
	Object.defineProperty(this, 'timeStamp', { value: ts })
}

ReconnectionInfo.prototype.next = function() {
	return new AuthInfo({
		correlationId: uuid.v4()
	, timeStamp: getIsoDate()
	})
}


function HeartbeatInfo(lastPackageNumber, isIntervalStage, timeStamp) {
	Object.defineProperty(this, 'LastPackageNumber', { value: lastPackageNumber })
	Object.defineProperty(this, 'IsIntervalStage', { value: isIntervalStage })
	Object.defineProperty(this, 'TimeStamp', { value: timeStamp })
}


function ReconnectionInfo(args) {
	var val = !!args ? args.reconnectionAttempt : 0
		, ts = !!args ? args.timeStamp : getIsoDate()
	Object.defineProperty(this, 'reconnectionAttempt', { value: val })
	Object.defineProperty(this, 'timeStamp', { value: ts })
}

ReconnectionInfo.prototype.next = function() {
	return new ReconnectionInfo({
		value: this.reconnectionAttempt + 1
	, timeStamp: getIsoDate()
	})
}
