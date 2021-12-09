const program = require('commander');
const grpc = require('@grpc/grpc-js');
const protoLoader = require('@grpc/proto-loader');
const fs = require('fs');
const Path = require('path');
const crypto = require("crypto");
const csv = require("csvtojson");

const version = JSON.parse(fs.readFileSync(Path.join(__dirname, 'package.json'), 'utf-8')).version;
program.version(version);

const AVG_SEC_BETWEEN_FRAME = 4
const PROTO_PATH = __dirname + '/fuota.proto';

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

function aes128_encrypt(key, input) {
  const cipher = crypto.createCipheriv("aes-128-ecb", key, null);
  // return Buffer.concat([cipher.update(input), cipher.final()]).slice(0, 16);
  return cipher.update(input);
}

function myParseInt(value, dummyPrevious) {
  // parseInt takes a string and a radix
  const parsedValue = parseInt(value, 10);
  if (isNaN(parsedValue)) {
    throw new commander.InvalidArgumentError('Not a number.');
  }
  return parsedValue;
}

async function main() {
  program
    .requiredOption('-s, --server <server>', 'FUOTA server (f.e. example.com)')
    .option('-p, --port <port>', 'FUOTA server port', 8070)
    .requiredOption('-id, --app_id <id>', 'Application ID', myParseInt)
    .requiredOption('-f, --patch <file>', 'Patch file')
    .requiredOption('-d, --device_list <file>', 'List of device')
    .allowUnknownOption(false)
    .parse();

  const options = program.opts();

  console.log(options);

  const target = options.server + ':' + options.port;
  let client = new fuota_proto.FUOTAServerService(target,
                                       grpc.credentials.createInsecure());

  let patch_file = fs.readFileSync(options.patch);

  let devices = await csv({
    noheader: true,
    headers: ["DevEUI", "AppKey"],
    trim: true,
  }).fromFile(options.device_list);

  devices = devices.map(dev => {
    return {
      dev_eui: Buffer.from(dev.DevEUI, 'hex'),
      // McRootKey = aes128_encrypt(GenAppKey, 0x00 | pad16)
      mc_root_key: aes128_encrypt(Buffer.from(dev.AppKey, 'hex'), Buffer.alloc(16)),
    }
  });

  let deploy = {
    application_id: options.app_id,
    devices: devices,

    multicast_group_type:                 "CLASS_C",  // Device FW support only class C
    multicast_dr:                         6,
    multicast_frequency:                  924500000,
    multicast_group_id:                   0,    // Device FW have only 1 multicast session slot
    multicast_timeout:                    5,    // n = 0-15(4bit), 2^n sec

    unicast_timeout:                      { seconds: 660 },
    unicast_attempt_count:                1,

    fragmentation_fragment_size:          234,  // 3 fragment header, 13 mac header, 234+3+13 = 250, max 255
    payload:                              patch_file,
    fragmentation_redundancy:             40,   // Device FW set max to 40
    fragmentation_session_index:          0,    // Device FW have only 1 fragment session slot
    fragmentation_matrix:                 0,    // Device FW and FUOTA Server support only 0  (FragAlgo)
    fragmentation_block_ack_delay:        1,    // Device FW not implement this
    fragmentation_descriptor:             Buffer.alloc(4),  // Device FW ignore this

    request_fragmentation_session_status: "AFTER_FRAGMENT_ENQUEUE", // For class A device
  }

  if (deploy.unicast_attempt_count > 1) {
    console.warn("!!Warning!!");
    console.warn("If some device did not respond MulticastClassCSessionSetup.");
    console.warn("FUOTA server will retry and change the session start time.");
    console.warn("But did not tell to already answer device to change the start time.");
    console.warn("So already answer device will start the session before the FUOTA server sends multicast.");
    console.warn("!!Warning!!");
  }

  let no_frag = Math.ceil(patch_file.length / deploy.fragmentation_fragment_size);
  let send_time = no_frag * AVG_SEC_BETWEEN_FRAME;
  let session_time = deploy.unicast_timeout.seconds * deploy.unicast_attempt_count;
  if (send_time > session_time) {
    console.warn("!!Warning!!");
    console.warn("Multicast send durution is", send_time, "sec.");
    console.warn("Session durution is", session_time, "sec.");
    console.warn("FUOTA server will close session before multicast send finish.");
    console.warn("!!Warning!!");
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
      await sleep(30000);
    }
  });
}

main();