var http = require('http');
var https = require('https');

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
function rpc(host, port, method, params, callback){

    var data = JSON.stringify({
        id: "0",
        jsonrpc: "2.0",
        method: method,
        params: params
    });
    jsonHttpRequest(host, port, data, function(error, replyJson){
        if (error){
            callback(error);
            return;
        }
        callback(replyJson.error, replyJson.result)
    });
}

const net = require("net");
const winston = require('winston');
const cu = require('cuckaroo29s-hashing');
const cnUtil = require('cryptoforknote-util');
const bignum = require('bignum');

const logger = winston.createLogger({
  level: 'info',
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.colorize(),
    winston.format.splat(),
    winston.format.simple(),
    winston.format.printf(msg => `${msg.timestamp} - ${msg.level}: ${msg.message}`)
  ),
  transports: [
    new winston.transports.Console(),
  ]

});

process.on("uncaughtException", function(error) {
	logger.error(error);
});

const localport = 14650;

var target = 0;
var curr_height=1;
var current_fork=0;
var current_blocktemplate = "";
var current_prevhash = "";
var connectedMiners = {};

function getBlockTemplate(callback){
	rpc('127.0.0.1',39950,'getblocktemplate', {reserve_size: 8, wallet_address: 'fh44kXjeXWoEw6CmMLbEWaUgdKwPxz4ptD1QJg926g43XQq3JSRkEJoBYtRZDFaFxm1SzaJXteZCLaAdTBYpmVmB1buPJk1mZ'}, callback);
}
function getHeight(callback){
	rpc('127.0.0.1',39950,'getblockcount', null, callback);
}
function getBlockHash(callback){
	rpc('127.0.0.1',39950,'on_getblockhash', [curr_height - 1], callback);
}
	

function updateJob(reason)
{
	getBlockTemplate(function(error, result){
		if(error) {
			console.log(error);
			console.log(result);
			return;
		}



		var previous_hash_buf = Buffer.alloc(32);
		Buffer.from(result.blocktemplate_blob, 'hex').copy(previous_hash_buf,0,7,39);;
		var previous_hash = previous_hash_buf.toString('hex');
		
		if(Buffer.from(result.blocktemplate_blob, 'hex')[0] == 10){ current_fork=7 }else{ current_fork = 0 };

		if(previous_hash != current_prevhash)
		{
			current_prevhash = previous_hash;
			current_blocktemplate = result.blocktemplate_blob;
			target = result.difficulty;
			curr_height=result.height;
		
			logger.info('New block to mine at height %d w/ difficulty of %d (triggered by: %s)', result.height, result.difficulty, reason);
		
			for (var minerId in connectedMiners)
			{
				var miner = connectedMiners[minerId];
				var response2 = '{"id":"Stratum","jsonrpc":"2.0","method":"getjobtemplate","result":{"difficulty":1,"height":'+curr_height+',"job_id":0,"pre_pow":"'+ cnUtil.convert_blob(Buffer.from(current_blocktemplate, 'hex'),current_fork).toString('hex') +'"},"error":null}';
				miner.socket.write(response2+"\n");
			}
		}
	});
};
function checkheight()
{
	getHeight(function(error, result){
		if(error) {
			console.log(error);
			console.log(result);
			return;
		}

		if(curr_height != result.count)
		{
			updateJob('height_change');
		}
	});
};

function checklasthash()
{
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

function uid(){
	var min = 100000000000000;
	var max = 999999999999999;
	var id = Math.floor(Math.random() * (max - min + 1)) + min;
	return id.toString();
};

function Miner(id,socket){
	this.socket = socket;
	this.login = '';
	this.id = id;
	
	var client = this;
	
	socket.on('data', function(input) {
		for (var data of input.toString().trim().split("\n"))
			handleClient(data,client);
	});
	
	socket.on('close', function(had_error) {
		logger.info('miner con dropped '+client.id);
		delete connectedMiners[client.id];
	});
	socket.on('error', function(had_error) {
		socket.end();
	});
}
	
function handleClient(data,miner){
	
	var request = JSON.parse(data.replace(/([0-9]{15,30})/g, '"$1"'));//long numbers in quotes, js json can't handle 64bit ints, nonce is 64bit
	
	logger.debug("m->p "+JSON.stringify(request));

	var response;

	if(request && request.method && request.method == "login")
	{
		logger.info('miner connect '+request.params.login+' ('+request.params.agent+')');
		miner.login=request.params.login;
		response = '{"id":"Stratum","jsonrpc":"2.0","method":"login","result":"ok","error":null}';
	}
	else if(request && request.method && request.method == "submit")
	{
		var proof;
		if (current_fork==7)
		{
			var header =  Buffer.concat([cnUtil.convert_blob(Buffer.from(current_blocktemplate, 'hex'),current_fork),bignum(request.params.nonce,10).toBuffer({endian : 'big',size : 4})]);
			proof = cu.cuckaroo29s(header,request.params.pow);
		}else{
			logger.error('swap1 not supported');
		}
			
		if(curr_height != request.params.height)
		{
			logger.info('outdated');
			response = '{"id":"Stratum","jsonrpc":"2.0","method":"submit","result":null,"error":{code: -32503, message: "outdated"}}';
			response  = response+"\n"+'{"id":"Stratum","jsonrpc":"2.0","method":"getjobtemplate","result":{"difficulty":1,"height":'+curr_height+',"job_id":0,"pre_pow":"'+ cnUtil.convert_blob(Buffer.from(current_blocktemplate, 'hex'),current_fork).toString('hex') +'"},"error":null}';
		}
		else if(proof)
		{
			logger.info('wrong hash ('+miner.login+') '+proof);
			response = '{"id":"Stratum","jsonrpc":"2.0","method":"submit","result":null,"error":{code: -32502, message: "wrong hash"}}';
		}
		else
		{
		
			var shareBuffer = cnUtil.construct_block_blob(Buffer.from(current_blocktemplate, 'hex'), bignum(request.params.nonce,10).toBuffer({endian : 'little',size : 4}),current_fork,request.params.pow);

			var jobdiff = cu.getdifficultyfromhash(cu.cycle_hash(request.params.pow));

			if(jobdiff >= target)
			{
				response = '{"id":"Stratum","jsonrpc":"2.0","method":"submit","result":"blockfound","error":null}';
				logger.info('share ('+miner.login+') '+jobdiff+' / '+target+' (block)');
				rpc('127.0.0.1',39950,'submitblock', [shareBuffer.toString('hex')], function(error, result){
					updateJob('found block');
				});
			}else{
				response = '{"id":"Stratum","jsonrpc":"2.0","method":"submit","result":"ok","error":null}';
				logger.info('share ('+miner.login+') '+jobdiff+' / '+target);
			}
		}
		
	}else{
		response = '{"id":"Stratum","jsonrpc":"2.0","method":"getjobtemplate","result":{"difficulty":1,"height":'+curr_height+',"job_id":0,"pre_pow":"'+ cnUtil.convert_blob(Buffer.from(current_blocktemplate, 'hex'),current_fork).toString('hex') +'"},"error":null}';
	
	}

	miner.socket.write(response+"\n");
	logger.debug("p->m "+response);
};

var server = net.createServer(function (localsocket) {

	var minerId = uid();
	var miner = new Miner(minerId,localsocket);
	connectedMiners[minerId] = miner;
});

var server2 = net.createServer(function (localsocket) {
	updateJob('external');
});

server.timeout = 0;
server.listen(localport);
server2.listen(14651);

logger.info("start cuckaroo29s micropool on trill.seb.green, port %d (no tls)", localport);

updateJob('init');

