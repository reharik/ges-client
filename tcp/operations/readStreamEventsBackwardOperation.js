var util = require('util')
	, inspection = require('./inspection')
	, position = require('../position')
	, eventPayloads = require('../eventPayloads')
	, OperationBase = require('./operationBase').OperationBase


module.exports = ReadStreamEventsForward


function ReadStreamEventsForward(operationData) {
	if(!(this instanceof ReadStreamEventsForward)) {
		return new ReadStreamEventsForward(operationData)
	}
	OperationBase.call(this, operationData)

/*
, ReadStreamEventsBackward: function(operationData) {
		return {
			auth: operationData.auth
		, cb: operationData.cb
		, requestType: 'ReadStreamEventsBackward'
		, toRequestPayload: function(payload) {
				var payload = operationData.data

				return messageParser.serialize('ReadStreamEvents', {
					eventStreamId: operationData.stream
				, fromEventNumber: payload.start
				, maxCount: payload.count
				, resolveLinkTos: !!payload.resolveLinkTos
				, requireMaster: !!payload.requireMaster
		  	})
	  	}
		, responseType: 'ReadStreamEventsCompleted'
		, toResponseObject: function(payload) {
				var events = payload.events || []
				return {
					Status: payload.result
				, Events: events.map(eventPayloads.toResolvedEvent)
				, NextEventNumber: payload.nextEventNumber
				, LastEventNumber: payload.lastEventNumber
				, IsEndOfStream: payload.isEndOfStream
				}
			}
		}
	}
*/
	Object.defineProperty(this, 'requestMessage', { value: 'ReadStreamEventsBackward' })
	Object.defineProperty(this, 'requestType', { value: 'ReadStreamEvents' })
	Object.defineProperty(this, 'responseMessage', { value: 'ReadStreamEventsBackwardCompleted' })
	Object.defineProperty(this, 'responseType', { value: 'ReadStreamEventsCompleted' })

	Object.defineProperty(this, '_stream', { value: operationData.stream })
	Object.defineProperty(this, '_requireMaster', { value: !!operationData.requireMaster })

	Object.defineProperty(this, '_fromEventNumber', { value: operationData.data.start })
	Object.defineProperty(this, '_maxCount', { value: operationData.data.count })
	Object.defineProperty(this, '_resolveLinkTos', { value: !!operationData.data.resolveLinkTos })

	this._inspections = {
		Success: function(response) {
			this.succeed()
			return inspection(inspection.decision.EndOperation, 'Success')
		}
	, StreamDeleted: function(response) {
			this.succeed()
			return inspection(inspection.decision.EndOperation, 'StreamDeleted')
		}
  , NoStream: function(response) {
			this.succeed()
			return inspection(inspection.decision.EndOperation, 'NoStream')
		}
  , Error: function(response) {
  		if(response.error) {
  			throw new Error('WRONG CASING ON RESPONSE.ERROR')
  		}

  		var message = response.Error || '<no message>'
			this.fail(new Error(mesage))
			return inspection(inspection.decision.EndOperation, 'Error')
		}
  , AccessDenied: function(response) {
			this.fail(new Error('Read access denied for stream ' + this._stream + '.'))
			return inspection(inspection.decision.EndOperation, 'AccessDenied')
		}
	}
}
util.inherits(ReadStreamEventsForward, OperationBase)

ReadStreamEventsForward.prototype.toRequestPayload = function() {
	return this._serialize({
		eventStreamId: this._stream
	, fromEventNumber: this._fromEventNumber
	, maxCount: this._maxCount
	, resolveLinkTos: this._resolveLinkTos
	, requireMaster: this._requireMaster
	})
}
	
ReadStreamEventsForward.prototype.transformResponse = function(payload) {
	var events = payload.events || []
	return {
		Status: payload.result
	, Events: events.map(eventPayloads.toResolvedEvent)
	, NextEventNumber: payload.nextEventNumber
	, LastEventNumber: payload.lastEventNumber
	, IsEndOfStream: payload.isEndOfStream
	}
}

ReadStreamEventsForward.prototype.toString = function() {
	return 'Stream: ' + this._stream
				+ ', FromEventNumber: ' + this._fromEventNumber
				+ ', MaxCount: ' + this._maxCount
				+ ', ResolveLinkTos: ' + this._resolveLinkTos
				+ ', RequireMaster: ' + this._requireMaster
}
