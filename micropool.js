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
	ctrlport:14651,// use with https://github.com/swap-dev/on-block-notify.git

	//daemonport:29950,
	daemonport:39950,
	daemonhost:'127.0.0.1',

	//mining_address:'TNzeY8RbHbKZbdAiXbfXtLUGV7SrKjBDBVJ6HoiwbospS3zUApfp2QLPbcGzQfADLaTVCYfK8sFEFgkfV6tj2yUv3qj1UepJqh',
	mining_address:'fh44kXjeXWoEw6CmMLbEWaUgdKwPxz4ptD1QJg926g43XQq3JSRkEJoBYtRZDFaFxm1SzaJXteZCLaAdTBYpmVmB1buPJk1mZ'

};

const http = require('http');
const https = require('https');
const net = require("net");
const c29s = require('./c29s.js');
const verify_c29s = c29s.cwrap('c29s_verify', 'number', ['array','number','array']);
const check_diff = c29s.cwrap('check_diff', 'number', ['number','array']);

function seq(){
	var min = 1000000000;
	var max = 2000000000;
	var id = Math.floor(Math.random() * (max - min + 1)) + min;
	return id.toString();
};

function Log() {}
Log.prototype.log = function (level,message) { console.log(new Date(Date.now()).toISOString()+' ['+level+'] '+message); }
Log.prototype.info  = function (message) {this.log('info',message);}
Log.prototype.error = function (message) {this.log('error',message);}
Log.prototype.debug = function (message) {/*this.log('debug',message);*/}
const logger = new Log();

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
	rpc('getblocktemplate', {reserve_size: 0, wallet_address: config.mining_address}, callback);
}

var current_target    = 0;
var current_height    = 1;
var current_blob      = "";
var current_hashblob  = "";
var previous_hashblob = "";
var current_prevhash  = "";
var connectedMiners   = {};

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
		

		if(previous_hash != current_prevhash){

			current_prevhash = previous_hash;
			current_target = result.difficulty;
			current_blob = result.blocktemplate_blob;
			previous_hashblob = current_hashblob;
			current_hashblob = result.blockhashing_blob;
			current_height=result.height;

			logger.info('New block to mine at height '+result.height+' w/ difficulty of '+result.difficulty+' (triggered by: '+reason+')');
		
			for (var minerId in connectedMiners){
				var miner = connectedMiners[minerId];
				miner.nonces = [];
				var response2 = '{"id":"Stratum","jsonrpc":"2.0","method":"getjobtemplate","result":{"difficulty":'+miner.difficulty+',"height":'+current_height+',"job_id":'+seq()+',"pre_pow":"'+ result.blockhashing_blob +'"},"error":null}';
				//setTimeout(function(){ miner.socket.write(response2+"\n")},5000);
				miner.socket.write(response2+"\n");
			}
		}
		if(callback) callback();
	});
}

function Miner(id,socket){
	this.socket = socket;
	this.login = '';
	this.pass = '';
	this.begin = Date.now()/1000|0;
	this.shares = 0;
	this.difficulty = 1;
	this.id = id;
	this.nonces = [];
	
	var client = this;
	
	socket.on('data', function(input) {
		try{
			for (var data of input.toString().trim().split("\n"))
				handleClient(data,client);
		}
		catch(e){
			logger.error("error: "+e+" on data: "+input);
			socket.end();
		}
	});
	
	socket.on('close', function(had_error) {
		logger.info('miner connction dropped '+client.login);
		delete connectedMiners[client.id];
		socket.end();
	});

	socket.on('error', function(had_error) {
		socket.end();
	});
}
Miner.prototype.respose = function (result,error,request) {
	
	var response = JSON.stringify({
			id:request.id.toString(),
			jsonrpc:"2.0",
			method:request.method,
			result: (result?result:null),
			error: (error?error:null)
	});
	logger.debug("p->m "+response);
	this.socket.write(response+"\n");
}
	
function handleClient(data,miner){
	
	logger.debug("m->p "+data);

	var request = JSON.parse(data.replace(/([0-9]{15,30})/g, '"$1"'));//puts all long numbers in quotes, js can't handle 64bit ints

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
		return miner.respose('ok',null,request);
	}
	
	if(request && request.method && request.method == "submit") {

		if(!request.params || !request.params.job_id || !request.params.pow || !request.params.nonce || request.params.pow.length != 32) {

			logger.info('bad data ('+miner.login+')');
			return miner.respose(null,{code: -32502, message: "wrong hash"},request);
		}
		
		if(! nonceCheck(miner,request.params.pow.join('.'))) {
		
			logger.info('duplicate ('+miner.login+')');
			return miner.respose(null,{code: -32503, message: "duplicate"},request);
		}
		
		var cycle = Buffer.allocUnsafe(request.params.pow.length*4);
		for(var i in request.params.pow)
		{
			cycle.writeUInt32LE(request.params.pow[i], i*4);
		}
		var noncebuffer = Buffer.allocUnsafe(4);
		noncebuffer.writeUInt32BE(request.params.nonce,0);
		var header = Buffer.concat([Buffer.from(current_hashblob, 'hex'),noncebuffer]);
			
		if(verify_c29s(header,header.length,cycle)){

			var header_previous = Buffer.concat([Buffer.from(previous_hashblob, 'hex'),noncebuffer]);
			
			if(verify_c29s(header_previous,header_previous.length,cycle)){

				logger.info('stale ('+miner.login+')');
				return miner.respose('stale',null,request);
			}
			else{

				logger.info('wrong hash or very old ('+miner.login+') '+request.params.height);
				return miner.respose(null,{code: -32502, message: "wrong hash"},request);
			}
		}
		
		if(check_diff(current_target,cycle)) {
			
			var block = Buffer.from(current_blob, 'hex');
			for(var i in request.params.pow)
			{
				block.writeUInt32LE(request.params.pow[i], 43+(i*4));
			}
			block.writeUInt32LE(request.params.nonce,39);

			rpc('submitblock', [block.toString('hex')], function(error, result){
				logger.info('BLOCK ('+miner.login+')');
				updateJob('found block');
			});
		}
		
		if(check_diff(miner.difficulty,cycle)) {
				
			logger.info('share ('+miner.login+') '+miner.difficulty+' ('+hashrate(miner)+')');
			return miner.respose('ok',null,request);
		}
		else{

			logger.info('low diff ('+miner.login+') '+miner.difficulty);
			return miner.respose(null,{code: -32501, message: "low diff"},request);
		}
		
	}
	
	if(request && request.method && request.method == "getjobtemplate") {
		
		return miner.respose({difficulty:parseFloat(miner.difficulty),height:current_height,job_id:parseFloat(seq()),pre_pow:current_hashblob},null,request);
	}
	else{

		logger.info("unkonwn method: "+request.method);
	}

}

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
	logger.info("start swap micropool, port "+config.poolport);

});

setInterval(function(){
	updateJob('timer');
}, 100);

