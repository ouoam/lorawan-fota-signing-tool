
const PROTO_PATH = __dirname + '/fuota.proto';

const parseArgs = require('minimist');
const grpc = require('@grpc/grpc-js');
const protoLoader = require('@grpc/proto-loader');
const fs = require('fs');
var packageDefinition = protoLoader.loadSync(
    PROTO_PATH,
    {keepCase: true,
     longs: String,
     enums: String,
     defaults: true,
     oneofs: true
    });
var fuota_proto = grpc.loadPackageDefinition(packageDefinition).fuota;

function sleep(ms) {
  return new Promise((res, rej) => setTimeout(res, ms));
}

function main() {
  var argv = parseArgs(process.argv.slice(2), {
    string: 'target'
  });
  var target;
  if (argv.target) {
    target = argv.target;
  } else {
    target = 'localhost:8070';
  }

  var file = fs.readFileSync("signed-diff.bin");

  var client = new fuota_proto.FUOTAServerService(target,
                                       grpc.credentials.createInsecure());

  var deploy = {
    application_id: 1,
    devices: [
      {
        dev_eui: Buffer.from('70B3D57ED0045268', 'hex'),
        mc_root_key: Buffer.from('2c62dbf08cde92e5704da76a4999b2af', 'hex'),
      },
    ],

    multicast_group_type:                 1,
    multicast_dr:                         6,
    multicast_frequency:                  924500000,
    multicast_group_id:                   0,
    multicast_timeout:                    5, // n = 0-15(4bit), 2^n sec

    unicast_timeout:                      { seconds: 30 },
    unicast_attempt_count:                2,

    fragmentation_fragment_size:          226,
    payload:                              file,
    fragmentation_redundancy:             40,
    fragmentation_session_index:          0,
    fragmentation_matrix:                 0,
    fragmentation_block_ack_delay:        1,
    fragmentation_descriptor:             Buffer.from('00000000', 'hex'),

    request_fragmentation_session_status: 0,
  }

  client.CreateDeployment({deployment: deploy}, async function(err, res) {
    console.log("create", err, res);
    while(true) {
      client.GetDeploymentStatus({id: res.id}, function(err, res) {
        console.log("get", err);
        console.dir(res, { depth: null })
      });
      client.GetDeploymentDeviceLogs({deployment_id: res.id, dev_eui: deploy.devices[0].dev_eui}, function(err, res) {
        console.log("log", err);
        console.dir(res, { depth: null })
      });
      await sleep(5000);
    }
  });
}

main();