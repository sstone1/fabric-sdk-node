/**
 * Copyright 2019 IBM All Rights Reserved.
 *
 * SPDX-License-Identifier: Apache-2.0
 */

const TYPE = 'Commit';

const {checkParameter, getLogger} = require('./Utils.js');
const logger = getLogger(TYPE);

const Proposal = require('./Proposal.js');
const fabprotos = require('fabric-protos');


/**
 * @classdesc
 * This class represents an Commit definition.
 * This class allows an application to contain all proposal attributes and
 * artifacts in one place during an endorsement commit.
 *
 * @class
 */
class Commit extends Proposal {

	/**
	 * Construct a Proposal object.
	 *
	 * @param {string} chaincodeName - The chaincode this proposal will execute
	 * @param {Channel} channel - The channel of this proposal
	 * @returns {Proposal} The Proposal instance.
	 */
	constructor(chaincodeName = checkParameter('chaincodeName'), channel = checkParameter('channel'), endorsement) {
		super(chaincodeName, channel);
		const method = `constructor[${chaincodeName}]`;
		logger.debug('%s - start', method);
		this.type = TYPE;
		this._endorsement = endorsement;
	}

	/**
	 * @typedef {Object} CommitBuildRequest
	 * @property {Endorsement} endorsement - Required. The Endorsement
	 *  that will be committed.
	 */
	/**
	 * This method is used to build the protobuf objects of the commit.
	 * The commit must next be signed before being sent to be committed.
	 * @param {IdentityContext} [idContext] - The context is not used
	 *  and is only specified here to be consistent with other ServiceAction
	 *  build method calls.
	 * @param {CommitBuildRequest} request - The commit options of the request.
	 * @returns {byte[]} The commits payload bytes to be signed.
	 */
	build(idContext = checkParameter('idContext'), request = {}) {
		const method = `build[${this.chaincodeName}]`;
		logger.debug('%s - start - %s', method, idContext.name);

		if (request.endorsement) {
			this._endorsement = request.endorsement;
		}

		if (!this._endorsement) {
			checkParameter('endorsement');
		}

		if (!this._endorsement._proposalResponses) {
			throw Error('Proposal has not been endorsed');
		}

		this._reset();
		const endorsements = [];
		for (const proposalResponse of this._endorsement._proposalResponses) {
			if (proposalResponse && proposalResponse.response && proposalResponse.response.status === 200) {
				endorsements.push(proposalResponse.endorsement);
			}
		}

		if (endorsements.length < 1) {
			logger.error('%s - no valid endorsements found', method);
			throw new Error('No valid endorsements found');
		}
		const proposalResponse = this._endorsement._proposalResponses[0];

		const chaincodeEndorsedAction = new fabprotos.protos.ChaincodeEndorsedAction();
		chaincodeEndorsedAction.setProposalResponsePayload(proposalResponse.payload);
		chaincodeEndorsedAction.setEndorsements(endorsements);

		const chaincodeActionPayload = new fabprotos.protos.ChaincodeActionPayload();
		chaincodeActionPayload.setAction(chaincodeEndorsedAction);

		// the TransientMap field inside the original proposal payload is only meant for the
		// endorsers to use from inside the chaincode. This must be taken out before sending
		// to the committer, otherwise the transaction will be rejected by the validators when
		// it compares the proposal hash calculated by the endorsers and returned in the
		// proposal response, which was calculated without the TransientMap
		const originalChaincodeProposalPayload = fabprotos.protos.ChaincodeProposalPayload.decode(this._endorsement._action.proposal.getPayload());
		const chaincodeProposalPayloadNoTrans = new fabprotos.protos.ChaincodeProposalPayload();
		chaincodeProposalPayloadNoTrans.setInput(originalChaincodeProposalPayload.input); // only set the input field, skipping the TransientMap
		chaincodeActionPayload.setChaincodeProposalPayload(chaincodeProposalPayloadNoTrans.toBuffer());

		const transactionAction = new fabprotos.protos.TransactionAction();
		transactionAction.setHeader(this._endorsement._action.header.getSignatureHeader());
		transactionAction.setPayload(chaincodeActionPayload.toBuffer());

		const actions = [];
		actions.push(transactionAction);

		const transaction = new fabprotos.protos.Transaction();
		transaction.setActions(actions);

		this._action.payload = new fabprotos.common.Payload();
		this._action.payload.setHeader(this._endorsement._action.header);
		this._action.payload.setData(transaction.toBuffer());
		this._payload = this._action.payload.toBuffer();

		return this._payload;
	}

	/**
	 * @typedef {Object} CommitSendRequest
	 * @property {Committers[]} [targets] - Optional. The Committers to send the endorsements.
	 * When not included an handler must be included.
	 * @property {EndorsementHandler} - [handler] - Optional. The handler to send the endorsements.
	 * When not included, targets must be included.
	 * @property {Number} [requestTimeout] - Optional. The request timeout
	 */

	/**
	 * Send the proposal responses that contain the endorsements of a transaction proposal
	 * to an committer for further processing. This is the 2nd phase of the transaction
	 * lifecycle in the fabric. The committer will globally order the transactions in the
	 * context of this channel and deliver the resulting blocks to the committing peers for
	 * validation against the chaincode's endorsement policy. When the committing peers
	 * successfully validate the transactions, it will mark the transaction as valid inside
	 * the block. After all transactions in a block have been validated, and marked either as
	 * valid or invalid (with a [reason code]{@link https://github.com/hyperledger/fabric/blob/v1.0.0/protos/peer/transaction.proto#L125}),
	 * the block will be appended (committed) to the channel's ledger on the peer.
	 * <br><br>
	 * This method will use the proposal responses returned from the {@link Proposal#endorse} along
	 * with the proposal that was sent for endorsement.
	 *
	 * @param {CommitSendRequest} request - {@link CommitRequest}
	 * @returns commit results
	 */
	async send(request = {}) {
		const method = `send[${this.chaincodeName}]`;
		logger.debug('%s - start', method);

		const {handler, targets, requestTimeout} = request;

		const envelope = this.getSignedEnvelope();

		if (handler) {
			logger.debug('%s - calling the handler');
			const result = await handler.commit(envelope, request);

			return result;
		} else if (targets) {
			logger.debug('%s - sending to the targets');
			const committers = this.channel.getTargetCommitters(targets);
			let bad_result = {};
			bad_result.status = 'UNKNOWN';
			for (const committer of committers) {
				const result = await committer.sendBroadcast(envelope, requestTimeout);
				if (result.status === 'SUCCESS') {

					return result;
				} else {
					bad_result = result;
				}
			}

			return bad_result;
		} else {
			throw Error('Missing targets parameter');
		}
	}

	/**
	 * return a printable representation of this object
	 */
	toString() {

		return `Commit: {chaincodeName: ${this.chaincodeName}, channel: ${this.channel.name}}`;
	}
}

module.exports = Commit;