import { Command, Option } from 'commander';
import grpc from '@grpc/grpc-js';
import protoLoader from '@grpc/proto-loader';
import fs from 'fs';
import Path from 'path';
import crypto from "crypto";
import csv from "csvtojson";
import chalk from 'chalk';

const version = JSON.parse(fs.readFileSync(Path.join(Path.resolve(), 'package.json'), 'utf-8')).version;
const program = new Command().version(version);

const AVG_SEC_BETWEEN_FRAME = 4
const PROTO_PATH = Path.resolve() + '/fuota.proto';

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
    .addOption(new Option('-s, --server <server>', 'FUOTA server (f.e. example.com)')
      .makeOptionMandatory(true)
      .env('SERVER')
    )
    .addOption(new Option('-p, --port <number>', 'FUOTA server port')
      .default(8070)
      .env('PORT')
    )
    .requiredOption('-id, --app_id <id>', 'Application ID', myParseInt)
    .requiredOption('--patch <file>', 'Patch file')
    .requiredOption('--list <file>', 'List of device')
    .addOption(new Option('-F, --no-follow', 'Do not follow until completed')
      .env('NO_FOLLOW')
    )
    .addOption(new Option('-C, --no-colour', 'turn off colour output')
      .env('NO_COLOUR')
    )
    .allowUnknownOption(false)
    .parse();

  const options = program.opts();

  if (!options.colour) {
    chalk.level = 0;
  }

  const date = chalk.magenta;
  // const warning = chalk.hex('#FFA500'); // Orange color
  const warning = chalk.black.bgYellow;

  const target = options.server + ':' + options.port;
  let client = new fuota_proto.FUOTAServerService(target,
                                       grpc.credentials.createInsecure());

  let patch_file = fs.readFileSync(options.patch);

  let devices = await csv({
    noheader: true,
    headers: ["DevEUI", "AppKey"],
    trim: true,
  }).fromFile(options.list);

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
    console.log(warning("!!Warning!!"));
    console.log("If some device did not respond MulticastClassCSessionSetup.");
    console.log("FUOTA server will retry and change the session start time.");
    console.log("But did not tell to already answer device to change the start time.");
    console.log("So already answer device will start the session before the FUOTA server sends multicast.");
    console.log(warning("!!Warning!!"));
  }

  let no_frag = Math.ceil(patch_file.length / deploy.fragmentation_fragment_size);
  let send_time = no_frag * AVG_SEC_BETWEEN_FRAME;
  let session_time = deploy.unicast_timeout.seconds * deploy.unicast_attempt_count;
  if (send_time > session_time) {
    console.log(warning("!!Warning!!"));
    console.log("Multicast send duration is", send_time, "sec.");
    console.log("Session duration is", session_time, "sec.");
    console.log("FUOTA server will close session before multicast send finish.");
    console.log(warning("!!Warning!!"));
  }

  function CreateDeployment(deploy) {
    return new Promise((resolve, reject) => 
      client.CreateDeployment({deployment: deploy}, function(err, res) {
        if(err) {
          return reject(err);
        }
        resolve(res.id);
      })
    );
  }

  function GetDeploymentStatus(deployID) {
    return new Promise((resolve, reject) => 
      client.GetDeploymentStatus({id: deployID}, function(err, res) {
        if(err) {
          return reject(err);
        }
        resolve(res);
      })
    );
  }

  let deployID = await CreateDeployment(deploy);
  console.log("deployment ID", deployID);

  if (options.follow) {
    let lastUpdateTime = 0;
    let printed = {};

    while(true) {
      let status = await GetDeploymentStatus(deployID);
      if (lastUpdateTime != status.updated_at.seconds) {
        lastUpdateTime = status.updated_at.seconds;
        delete status.device_status;
        // delete status.created_at;
        delete status.updated_at;

        for (const [key, value] of Object.entries(status)) {
          if (value !== null && !printed[key]) {
            printed[key] = true;
            let iso = new Date((value.seconds * 1000) + (value.nanos / 1000000)).toISOString();
            console.log(key, date(iso));
          }
        }
      }

      if (status.frag_status_completed_at !== null) {
        break;
      }
      await sleep(5000);
    }
  }
}

main();