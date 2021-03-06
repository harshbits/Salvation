var CryptoJS = require("crypto-js");
var WebSocket = require("ws");
var bodyParser = require('body-parser');
var http_port = process.env.HTTP_PORT || 3001;
var p2p_port = process.env.P2P_PORT || 6001;
var Block = require('../block').Block
var getGenesisBlock = require('../block').getGenesisBlock
var bodyParser = require('body-parser');
var initialPeers = process.env.PEERS ? process.env.PEERS.split(',') : [];
var axios = require('axios')
const redis = require('redis')

var sockets = [];
var MessageType = {
    QUERY_LATEST: 0,
    QUERY_ALL: 1,
    RESPONSE_BLOCKCHAIN: 2
};
var client = redis.createClient('redis://redistogo:36dbd143f60a86077a358b0b4e14df0a@albacore.redistogo.com:9013/?db=0');


var blockchain = {}

const initHttpServer = (app) => {
    app.use(bodyParser.json());

    app.get('/blocks/:qrCode', (req, res) => {
        client.lrange(req.params.qrCode, 0, -1, (err, result) => {
            const finalRes = result.map((o) => {
                const resObj = JSON.parse(o)
                return Object.assign({}, {pos: `${resObj.pos.lat} , ${resObj.pos.lng}`} , resObj.data, { riskFactor: resObj.riskFactor })
            })
            res.send(finalRes)
        });
    })

    app.post('/startBlockChain', (req, res) => {
        console.log('check startBlockChain req.body: ', req.body);
        fetchAndSaveAnimalInfo(req.body, generateFirstBlock)
        res.send();
    })

    app.post('/mineBlock', (req, res) => {
        console.log('check mineBlock req.body: ', req.body);
        fetchAndSaveAnimalInfo(req.body, generateNextBlock, addBlock)
        res.send();
    });

    app.get('/peers', (req, res) => {
        res.send(sockets.map(s => s._socket.remoteAddress + ':' + s._socket.remotePort));
    });

    app.post('/addPeer', (req, res) => {
        connectToPeers([req.body.peer]);
        res.send();
    });

    app.listen(http_port, () => console.log('Listening http on port: ' + http_port));
};

const fetchAndSaveAnimalInfo = (reqData, generateBlock, addBlock) => {
    axios.post('https://eco-savior-ws.herokuapp.com/analyze', reqData).then((response) => {
        generateBlock(response.data, (result) => {
            var newBlock = result
            if(addBlock){
                addBlock(newBlock, reqData.qrCode)
            } else {
                client.rpush([reqData.qrCode, JSON.stringify(newBlock)])
            }
            broadcast(responseLatestMsg(newBlock));
            console.log('block added: ' + JSON.stringify(response.data));
        });
    }).catch((err) => {
        console.log("error in harsh api: ", err);
    })
}


const generateFirstBlock = (blockData, callback ) => {
    const index  = 1;
    const timestamp = new Date().getTime() / 1000;
    const previousHash = '816534932c2b7154836da6afc367695e6337db8a921823784c14378abed4f7d7'
    const firstHash = calculateHash(index, previousHash, timestamp, blockData);
    callback(new Block(index, previousHash, timestamp, blockData, firstHash));
}

const generateNextBlock = (blockData, callback) => {
    getLatestBlock(blockData.qrCode, (res) => {
        var previousBlock = res;
        var nextIndex = previousBlock.index + 1;
        var nextTimestamp = new Date().getTime() / 1000;
        var nextHash = calculateHash(nextIndex, previousBlock.hash, nextTimestamp, blockData);
        callback(new Block(nextIndex, previousBlock.hash, nextTimestamp, blockData, nextHash));
    })
};

var addBlock = (newBlock, qrCode) => {
    client.rpush([qrCode, JSON.stringify(newBlock)])
};

var getLatestBlock = (qrCode, callback) => {
    client.lrange(qrCode, 0, -1, (err, res) => {
        callback(JSON.parse(res[res.length - 1]))
    });
}

var isValidNewBlock = (newBlock, previousBlock) => {
    if (previousBlock.index + 1 !== newBlock.index) {
        console.log('invalid index');
        return false;
    } else if (previousBlock.hash !== newBlock.previousHash) {
        console.log('invalid previoushash');
        return false;
    } else if (calculateHashForBlock(newBlock) !== newBlock.hash) {
        console.log(typeof (newBlock.hash) + ' ' + typeof calculateHashForBlock(newBlock));
        console.log('invalid hash: ' + calculateHashForBlock(newBlock) + ' ' + newBlock.hash);
        return false;
    }
    return true;
};

var calculateHashForBlock = (block) => {
    return calculateHash(block.index, block.previousHash, block.timestamp, block.data);
};

var calculateHash = (index, previousHash, timestamp, data) => {
    const prevHash = previousHash || '816534932c2b7154836da6afc367695e6337db8a921823784c14378abed4f7d7'
    return CryptoJS.SHA256(index + prevHash + timestamp + data).toString();
};

var broadcast = (message) => sockets.forEach(socket => write(socket, message));

var responseLatestMsg = (newBlock) => ({
    'type': MessageType.RESPONSE_BLOCKCHAIN,
    'data': newBlock
});

const connectToPeers = (newPeers) => {
    newPeers.forEach((peer) => {
        var ws = new WebSocket(peer);
        ws.on('open', () => initConnection(ws));
        ws.on('error', () => {
            console.log('connection failed')
        });
    });
};

var initConnection = (ws) => {
    sockets.push(ws);
    initMessageHandler(ws);
    initErrorHandler(ws);
    write(ws, queryChainLengthMsg());
};

var initMessageHandler = (ws) => {
    ws.on('message', (data) => {
        var message = JSON.parse(data);
        console.log('Received message' + JSON.stringify(message));
        switch (message.type) {
            case MessageType.QUERY_LATEST:
                write(ws, responseLatestMsg());
                break;
            case MessageType.QUERY_ALL:
                write(ws, responseChainMsg());
                break;
            case MessageType.RESPONSE_BLOCKCHAIN:
                handleBlockchainResponse(message);
                break;
        }
    });
};


var handleBlockchainResponse = (message) => {
    var receivedBlocks = JSON.parse(message.data).sort((b1, b2) => (b1.index - b2.index));
    var latestBlockReceived = receivedBlocks[receivedBlocks.length - 1];
    var latestBlockHeld = getLatestBlock();
    if (latestBlockReceived.index > latestBlockHeld.index) {
        console.log('blockchain possibly behind. We got: ' + latestBlockHeld.index + ' Peer got: ' + latestBlockReceived.index);
        if (latestBlockHeld.hash === latestBlockReceived.previousHash) {
            console.log("We can append the received block to our chain");
            blockchain.push(latestBlockReceived);
            broadcast(responseLatestMsg());
        } else if (receivedBlocks.length === 1) {
            console.log("We have to query the chain from our peer");
            broadcast(queryAllMsg());
        } else {
            console.log("Received blockchain is longer than current blockchain");
            replaceChain(receivedBlocks);
        }
    } else {
        console.log('received blockchain is not longer than current blockchain. Do nothing');
    }
};

var replaceChain = (newBlocks) => {
    if (isValidChain(newBlocks) && newBlocks.length > blockchain.length) {
        console.log('Received blockchain is valid. Replacing current blockchain with received blockchain');
        blockchain = newBlocks;
        broadcast(responseLatestMsg());
    } else {
        console.log('Received blockchain invalid');
    }
};

var isValidChain = (blockchainToValidate) => {
    if (JSON.stringify(blockchainToValidate[0]) !== JSON.stringify(getGenesisBlock())) {
        return false;
    }
    var tempBlocks = [blockchainToValidate[0]];
    for (var i = 1; i < blockchainToValidate.length; i++) {
        if (isValidNewBlock(blockchainToValidate[i], tempBlocks[i - 1])) {
            tempBlocks.push(blockchainToValidate[i]);
        } else {
            return false;
        }
    }
    return true;
};




var queryChainLengthMsg = () => ({'type': MessageType.QUERY_LATEST});
var queryAllMsg = () => ({'type': MessageType.QUERY_ALL});
var responseChainMsg = () =>({
    'type': MessageType.RESPONSE_BLOCKCHAIN, 'data': JSON.stringify(blockchain)
});


var write = (ws, message) => ws.send(JSON.stringify(message));


var initErrorHandler = (ws) => {
    var closeConnection = (ws) => {
        console.log('connection failed to peer: ' + ws.url);
        sockets.splice(sockets.indexOf(ws), 1);
    };
    ws.on('close', () => closeConnection(ws));
    ws.on('error', () => closeConnection(ws));
};

const initP2PServer = () => {
    var server = new WebSocket.Server({port: p2p_port});
    server.on('connection', ws => initConnection(ws));
    console.log('listening websocket p2p port on: ' + p2p_port);

};

module.exports = { initP2PServer, initHttpServer, connectToPeers }
