/****************************************************
*
*	Solo Stratum Mining Pool for Swap 2.0
*
*	Cuckaroo29s hashing
*	static difficulty (seperated by '.' in login)
*
*****************************************************/

var config = { 

	poolport:14650, 
	ctrlport:14651,

	daemonport:39950,
	daemonhost:'127.0.0.1',

	mining_address:'fh44kXjeXWoEw6CmMLbEWaUgdKwPxz4ptD1QJg926g43XQq3JSRkEJoBYtRZDFaFxm1SzaJXteZCLaAdTBYpmVmB1buPJk1mZ'

};

const http = require('http');
const https = require('https');
const net = require("net");
const winston = require('winston');
const cu = require('cuckaroo29s-hashing');
const cnUtil = require('cryptoforknote-util');
const bignum = require('bignum');
const crypto = require('crypto');

const seed = Math.random();
const p = bignum(4294967291);
function permute(x)
{
	if (x.ge(p)) return x;
	var r = x.mul(x).mod(p);
	return (x.le(p.div(2)))?r:p.sub(r);
}
var state=bignum(seed);
function seq()
{
	state = permute(permute(state).add(seed).xor(1542469173));
	return state.toBuffer({size:4}).toString('hex');
}
const inctanceid = seq();

const logger = winston.createLogger({
	level: 'info',
	format: winston.format.combine(
		winston.format.timestamp(),
		winston.format.colorize(),
		winston.format.splat(),
		winston.format.printf(msg => `${msg.timestamp} - ${msg.level}: ${msg.message}`)
	),
	transports: [
		new winston.transports.Console(),
	]
});

process.on("uncaughtException", function(error) {
	logger.error(error);
});

function jsonHttpRequest(host, port, data, callback, path){
	path = path || '/json_rpc';

	var options = {
		hostname: host,
		port: port,
		path: path,
		method: data ? 'POST' : 'GET',
		headers: {
			'Content-Length': data.length,
			'Content-Type': 'application/json',
			'Accept': 'application/json'
		}
	};

	var req = (port == 443 ? https : http).request(options, function(res){
		var replyData = '';
		res.setEncoding('utf8');
		res.on('data', function(chunk){
			replyData += chunk;
		});
		res.on('end', function(){
			var replyJson;
			try{
				replyJson = JSON.parse(replyData);
			}
			catch(e){
				callback(e);
				return;
			}
			callback(null, replyJson);
		});
	});

	req.on('error', function(e){
		callback(e);
	});

	req.end(data);
}

function rpc(method, params, callback){

	var data = JSON.stringify({
		id: "0",
		jsonrpc: "2.0",
		method: method,
		params: params
	});
	jsonHttpRequest(config.daemonhost, config.daemonport, data, function(error, replyJson){
		if (error){
			callback(error);
			return;
		}
		callback(replyJson.error, replyJson.result)
	});
}

function getBlockTemplate(callback){
	rpc('getblocktemplate', {reserve_size: 4, wallet_address: config.mining_address}, callback);
}

function getHeight(callback){
	rpc('getblockcount', null, callback);
}

function getBlockHash(callback){
	rpc('on_getblockhash', [curr_height - 1], callback);
}
	
var target = 0;
var curr_height=1;
var current_blob = "";
var current_fork=0;
var current_prevhash = "";
var current_reserveOffset = 0;
var connectedMiners = {};

function get_blob(minerId){

	var blob = Buffer.from(current_blob,'hex');

	if(current_reserveOffset) {
	
		var jobid = Buffer.from(seq(),'hex');
		jobid.copy(blob, current_reserveOffset, 0, 3);
	}
	
	return blob.toString('hex');
}

function nonceCheck(miner,nonce) {

	if (miner.nonces.indexOf(nonce) !== -1) return false;

	miner.nonces.push(nonce);

	return true;
}

function hashrate(miner) {

	miner.shares += miner.difficulty|0;

	var hr = miner.shares*32/((Date.now()/1000|0)-miner.begin);

	return 'rig:'+miner.pass+' '+hr.toFixed(2)+' gps';

}


function updateJob(reason,callback){

	getBlockTemplate(function(error, result){
		if(error) {
			console.log(error);
			console.log(result);
			return;
		}

		var previous_hash_buf = Buffer.alloc(32);
		Buffer.from(result.blocktemplate_blob, 'hex').copy(previous_hash_buf,0,7,39);;
		var previous_hash = previous_hash_buf.toString('hex');
		
		if(Buffer.from(result.blocktemplate_blob, 'hex')[0] >= 10){ current_fork=7 }else{ current_fork = 0 };

		if(previous_hash != current_prevhash){

			current_prevhash = previous_hash;
			target = result.difficulty;
			current_blob = result.blocktemplate_blob;
			curr_height=result.height;
			current_reserveOffset = result.reserved_offset;

			logger.info('New block to mine at height %d w/ difficulty of %d (triggered by: %s)', result.height, result.difficulty, reason);
		
			for (var minerId in connectedMiners){
				var miner = connectedMiners[minerId];
				miner.current_blocktemplate = get_blob(minerId);
				miner.nonces = [];
				var response2 = '{"id":"Stratum","jsonrpc":"2.0","method":"getjobtemplate","result":{"difficulty":'+miner.difficulty+',"height":'+curr_height+',"job_id":0,"pre_pow":"'+ cnUtil.convert_blob(Buffer.from(miner.current_blocktemplate, 'hex'),current_fork).toString('hex') +'"},"error":null}';
				miner.socket.write(response2+"\n");
			}
		}
		if(callback) callback();
	});
}

function checkheight() {

	getHeight(function(error, result){
		if(error) {
			console.log(error);
			console.log(result);
			return;
		}

		if(curr_height != result.count){
			updateJob('height_change');
		}
	});
}

function checklasthash() {

	getBlockTemplate(function(error, result){
		if(error) {
			console.log(error);
			console.log(result);
			return;
		}
		if(result.prev_hash != current_prevhash) {
			updateJob('lasthash updated');
		}
	});
}

setInterval(function(){ checkheight()}, 250);
setInterval(function(){ checklasthash()}, 1000);

function Miner(id,socket){
	this.socket = socket;
	this.login = '';
	this.pass = '';
	this.begin = Date.now()/1000|0;
	this.shares = 0;
	this.difficulty = 1;
	this.id = id;
	this.nonces = [];
	this.current_blocktemplate = get_blob(id);
	
	var client = this;
	
	socket.on('data', function(input) {
		for (var data of input.toString().trim().split("\n"))
			handleClient(data,client);
	});
	
	socket.on('close', function(had_error) {
		logger.info('miner connction dropped '+client.login);
		delete connectedMiners[client.id];
	});

	socket.on('error', function(had_error) {
		socket.end();
	});
}
	
function handleClient(data,miner){
	
	var request = JSON.parse(data.replace(/([0-9]{15,30})/g, '"$1"'));//puts all long numbers in quotes, js can't handle 64bit ints
	
	logger.debug("m->p "+JSON.stringify(request));

	var response;

	if(request && request.method && request.method == "login") {

		miner.login=request.params.login;
		miner.pass =request.params.pass;
		var fixedDiff = miner.login.indexOf('.');
		if(fixedDiff != -1) {
			miner.difficulty = miner.login.substr(fixedDiff + 1);
			if(miner.difficulty < 1) miner.difficulty = 1;
			if(isNaN(miner.difficulty)) miner.difficulty = 1;
			miner.login = miner.login.substr(0, fixedDiff);
		}
		logger.info('miner connect '+request.params.login+' ('+request.params.agent+') ('+miner.difficulty+')');
		response = '{"id":"Stratum","jsonrpc":"2.0","method":"login","result":"ok","error":null}';
	}
	else if(request && request.method && request.method == "submit") {

		var proof;
		if (current_fork==7){
			var header =  Buffer.concat([cnUtil.convert_blob(Buffer.from(miner.current_blocktemplate, 'hex'),current_fork),bignum(request.params.nonce,10).toBuffer({endian : 'big',size : 4})]);
			proof = cu.cuckaroo29s(header,request.params.pow);
		}
		else{
			logger.error('swap1 not supported');
		}
			
		if(curr_height != request.params.height){

			logger.info('outdated');
			response = '{"id":"Stratum","jsonrpc":"2.0","method":"submit","result":null,"error":{code: -32503, message: "outdated"}}';
			response  = response+"\n"+'{"id":"Stratum","jsonrpc":"2.0","method":"getjobtemplate","result":{"difficulty":'+miner.difficulty+',"height":'+curr_height+',"job_id":0,"pre_pow":"'+ cnUtil.convert_blob(Buffer.from(current_blocktemplate, 'hex'),current_fork).toString('hex') +'"},"error":null}';
		}
		else if(proof){

			logger.info('wrong hash ('+miner.login+') '+proof);
			response = '{"id":"Stratum","jsonrpc":"2.0","method":"submit","result":null,"error":{code: -32502, message: "wrong hash"}}';
		
		} 
		else if(! nonceCheck(miner,request.params.nonce)) {
		
			logger.info('duplicate ('+miner.login+')');
			response = '{"id":"Stratum","jsonrpc":"2.0","method":"submit","result":null,"error":{code: -32503, message: "duplicate"}}';
		
		}
		else{
		
			var jobdiff = cu.getdifficultyfromhash(cu.cycle_hash(request.params.pow));

			if(jobdiff >= target) {
				
				response = '{"id":"Stratum","jsonrpc":"2.0","method":"submit","result":"blockfound","error":null}';
				logger.info('share ('+miner.login+') '+jobdiff+' / '+target+' (block) ('+hashrate(miner)+')');
				
				var shareBuffer = cnUtil.construct_block_blob(Buffer.from(miner.current_blocktemplate, 'hex'), bignum(request.params.nonce,10).toBuffer({endian : 'little',size : 4}),current_fork,request.params.pow);
				rpc('submitblock', [shareBuffer.toString('hex')], function(error, result){
					updateJob('found block');
				});
			}
			else if(jobdiff >= miner.difficulty) {
				
				response = '{"id":"Stratum","jsonrpc":"2.0","method":"submit","result":"ok","error":null}';
				logger.info('share ('+miner.login+') '+jobdiff+' / '+target+' ('+hashrate(miner)+')');
			
			}
			else{

				response = '{"id":"Stratum","jsonrpc":"2.0","method":"submit","result":null,"error":{code: -32501, message: "low diff"}}';
				logger.info('low diff ('+miner.login+') '+jobdiff+' / '+miner.difficulty);
			}
		}
		
	}else{
		response = '{"id":"Stratum","jsonrpc":"2.0","method":"getjobtemplate","result":{"difficulty":'+miner.difficulty+',"height":'+curr_height+',"job_id":0,"pre_pow":"'+ cnUtil.convert_blob(Buffer.from(miner.current_blocktemplate, 'hex'),current_fork).toString('hex') +'"},"error":null}';
	
	}

	miner.socket.write(response+"\n");
	logger.debug("p->m "+response);
};

var server = net.createServer(function (localsocket) {

	var minerId = seq();
	var miner = new Miner(minerId,localsocket);
	connectedMiners[minerId] = miner;
});
server.timeout = 0;

var ctrl_server = net.createServer(function (localsocket) {
	updateJob('ctrlport');
});
ctrl_server.listen(config.ctrlport,'127.0.0.1');

updateJob('init',function(){

	server.listen(config.poolport);
	logger.info("start swap micropool, port %d", config.poolport);

});

