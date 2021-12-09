#!/usr/bin/env node

import { Command, Option } from 'commander';
import UUID from 'uuid-1345';
import fs from 'fs';
import Path from 'path';
import { spawnSync } from 'child_process';
import os from 'os';

const __dirname = Path.resolve();
const version = JSON.parse(fs.readFileSync(Path.join(__dirname, 'package.json'), 'utf-8')).version;

const certsFolder = Path.join(process.cwd(), '.fota-keys');

const program = new Command();
program.version(version)

function myParseInt(value, dummyPrevious) {
  // parseInt takes a string and a radix
  const parsedValue = parseInt(value, 10);
  if (isNaN(parsedValue)) {
    throw new commander.InvalidArgumentError('Not a number.');
  }
  return parsedValue;
}

program
  .command('create-keypair')
  .description('Generating keypair')
  .requiredOption('-d, --domain-name <domain>', 'Your domain (f.e. example.com)')
  .requiredOption('-m, --model <model>', 'Device model (f.e. awesome-2000)')
  .allowUnknownOption(false)
  .showHelpAfterError(true)
  .action((options) => {
    if (fs.existsSync(certsFolder)) {
      console.log(certsFolder, `folder already exists, refusing to overwrite existing certificates`);
      process.exit(1);
    }
    fs.mkdirSync(certsFolder);

    console.log('Creating keypair');

    let genKey = spawnSync('openssl', [
        'ecparam', '-genkey', '-name', 'secp256r1', '-out', Path.join(certsFolder, 'update.key')
    ]);
    if (genKey.status !== 0) {
      console.log('Generating keypair failed', genKey.status);
      console.log(genKey.stdout.toString('utf-8'));
      console.log(genKey.stderr.toString('utf-8'));
      process.exit(1);
    }

    let extractPub = spawnSync('openssl', [
      'ec', '-in', Path.join(certsFolder, 'update.key'), '-pubout'
    ]);
    if (extractPub.status !== 0) {
      console.log('Extracting public key failed', extractPub.status);
      console.log(extractPub.stdout.toString('utf-8'));
      console.log(extractPub.stderr.toString('utf-8'));
      process.exit(1);
    }

    let pubKey = extractPub.stdout;

    fs.writeFileSync(Path.join(certsFolder, 'update.pub'), pubKey);

    console.log('Creating keypair OK');

    let deviceIds = {
      'manufacturer-uuid': UUID.v5({
        namespace: UUID.namespace.url,
        name: options.domainName
      }),
      'device-class-uuid': UUID.v5({
        namespace: UUID.namespace.url,
        name: options.model
      })
    };

    fs.writeFileSync(Path.join(certsFolder, 'device-ids.json'), JSON.stringify(deviceIds, null, 4), 'utf-8');

    console.log('Wrote device-ids.json OK');

    // now create the .H file...
    let manufacturerUUID = new UUID(deviceIds['manufacturer-uuid']).toBuffer();
    let deviceClassUUID = new UUID(deviceIds['device-class-uuid']).toBuffer();

    let certs = `#ifndef _UPDATE_CERTS_H
#define _UPDATE_CERTS_H

const char * UPDATE_CERT_PUBKEY = ${JSON.stringify(pubKey.toString('utf-8'))};
const size_t UPDATE_CERT_LENGTH = ${pubKey.length + 1};

const uint8_t UPDATE_CERT_MANUFACTURER_UUID[16] = { ${Array.from(manufacturerUUID).map(c => '0x' + c.toString(16)).join(', ')} };
const uint8_t UPDATE_CERT_DEVICE_CLASS_UUID[16] = { ${Array.from(deviceClassUUID).map(c => '0x' + c.toString(16)).join(', ')} };

#endif // _UPDATE_CERTS_H_
`;

    console.log('Writing UpdateCerts.h');
    fs.writeFileSync(Path.join(process.cwd(), 'UpdateCerts.h'), certs, 'utf-8');
    console.log('Writing UpdateCerts.h OK');
  });


program
  .command('sign-binary')
  .description('Signing an update')
  .requiredOption('-b, --binary <file>', 'Binary to sign')
  .addOption(new Option('-f, --output-format <format>', 'Output format')
                .default('bin').choices(['bin', 'packets-plain', 'packets-h']))
  .requiredOption('-o, --out-file <file>', 'Output file')
  .option('--frag-size <number>', 'Fragmentation size (only when output-format is set to packets-*)', myParseInt)
  .option('--redundancy-packets <number>', 'Number of redundancy packets (only when output-format is set to packets-*)', myParseInt)
  .option('--override-version', 'Use now as version, instead of date the binary was created')
  .allowUnknownOption(false)
  .showHelpAfterError(true)
  .action((options) => {
    // this is not diff!
    let isDiffBuffer = Buffer.from([ 0, 0, 0, 0 ]);

    let manifest = _createManifest(options.binary, options.overrideVersion, isDiffBuffer);

    let outFile = Buffer.concat([
      fs.readFileSync(options.binary),
      manifest
    ]);

    switch (options.outputFormat) {
      case 'bin': {
        fs.writeFileSync(options.outFile, outFile);
        console.log('Written to', options.outFile);
        break;
      }

      case 'packets-plain': {
        return _packets_plain(options, outFile, options.outFile);
      }

      case 'packets-h': {
        return _packets_h(options, outFile, options.outFile);
      }
    }
  });


program
  .command('sign-delta')
  .description('Signing a delta update')
  .requiredOption('--old <file>', 'Old binary to generate diff from')
  .requiredOption('--new <file>', 'New binary to generate diff from')
  .addOption(new Option('-f, --output-format <format>', 'Output format')
                .default('bin').choices(['bin', 'packets-plain', 'packets-h']))
  .requiredOption('-o, --out-file <file>', 'Output file')
  .option('--frag-size <number>', 'Fragmentation size (only when output-format is set to packets-*)', myParseInt)
  .option('--redundancy-packets <number>', 'Number of redundancy packets (only when output-format is set to packets-*)', myParseInt)
  .option('--override-version', 'Use now as version, instead of date the binary was created')
  .allowUnknownOption(false)
  .showHelpAfterError(true)
  .action((options) => {
    // create the diff between these binaries...
    let tempFile = Path.join(process.cwd(), Date.now() + '.diff');
    let diffCmd = spawnSync(Path.join('bin', 'jdiff'), [
      options.old,
      options.new,
      tempFile
    ]);
    if (diffCmd.status !== 0) {
        console.log('Creating diff failed', diffCmd.status);

        console.log(diffCmd.stdout.toString('utf-8'));
        console.log(diffCmd.stderr.toString('utf-8'));
        try {
            fs.unlinkSync(tempFile);
        }
        catch (ex) {}

        if (diffCmd.status === 5) {
            console.log('This seems like a permission error. Do you have permission to write to',
                process.cwd(), '?');
        }

        process.exit(1);
    }

    let diff = fs.readFileSync(tempFile);

    fs.unlinkSync(tempFile);

    // this is diff
    let oldFileLength = fs.readFileSync(options.old).length;

    let isDiffBuffer = Buffer.from([ 1, (oldFileLength >> 16) & 0xff, (oldFileLength >> 8) & 0xff, oldFileLength & 0xff ]);

    console.log('diff buffer', isDiffBuffer);

    let manifest = _createManifest(options.new, options.overrideVersion, isDiffBuffer);

    let outFile = Buffer.concat([
      diff,
      manifest
    ]);

    switch (options.outputFormat) {
      case 'bin': {
        fs.writeFileSync(options.outFile, outFile);
        console.log('Written to', options.outFile);
        break;
      }

      case 'packets-plain': {
        return _packets_plain(options, outFile, options.outFile);
      }

      case 'packets-h': {
        return _packets_h(options, outFile, options.outFile);
      }
    }
  });

program
  .command('sign-external-delta')
  .description('Signing a external delta update')
  .requiredOption('--old <file>', 'Old binary to sign from')
  .requiredOption('--new <file>', 'New binary to sign from')
  .requiredOption('-i, --in-file <file>', 'Input delta file')
  .requiredOption('-o, --out-file <file>', 'Output file')
  .option('--override-version', 'Use now as version, instead of date the binary was created')
  .allowUnknownOption(false)
  .showHelpAfterError(true)
  .action((options) => {
    console.log('Old Bin Version is', fs.statSync(options.old).mtime.getTime() / 1000 | 0);
    console.log('New Bin Version is', fs.statSync(options.new).mtime.getTime() / 1000 | 0);

    //let tempFile = Path.join(process.cwd(), Date.now() + '.diff');
    let inputFile = fs.readFileSync(options.inFile); //CHANGE TO INPUT

    // this is diff
    let oldFileLength = fs.readFileSync(options.old).length;

    //building DiffBuffer with value 2
    let isDiffBuffer = Buffer.from([ 2, (oldFileLength >> 16) & 0xff, (oldFileLength >> 8) & 0xff, oldFileLength & 0xff ]);

    console.log('diff buffer', isDiffBuffer);

    let manifest = _createManifest(options.new, options.overrideVersion, isDiffBuffer);

    let outFile = Buffer.concat([
        inputFile,
        manifest
    ]);

    fs.writeFileSync(options.outFile, outFile);
    console.log('Written to', options.outFile);
  });

program
  .command('read-manifest')
  .description('Read Manifest')
  .requiredOption('-i, --input <file>', 'File to read manifest from')
  .allowUnknownOption(false)
  .showHelpAfterError(true)
  .action((options) => {
    _readManifest(options.input);
  });



function _createManifest(file, overrideVersion, isDiffBuffer) {
  let signature = _sign(file);
  let sigLength = Buffer.from([ signature.length ]);

  // always round up to 72 bytes
  if (signature.length === 70) {
    signature = Buffer.concat([ signature, Buffer.from([ 0, 0 ]) ]);
  }
  else if (signature.length === 71) {
    signature = Buffer.concat([ signature, Buffer.from([ 0 ]) ]);
  }

  let binVersion;
  if (overrideVersion) {
    console.log('Patch Version is', Date.now() / 1000 | 0, '(overriden)');
    binVersion = Date.now() / 1000 | 0;
  }
  else {
    binVersion = fs.statSync(file).mtime.getTime() / 1000 | 0;
    console.log('Patch Version is', binVersion);
  }

  let versionBuffer = Buffer.from([ binVersion & 0xff, (binVersion >> 8) & 0xff, (binVersion >> 16) & 0xff, (binVersion >> 24) & 0xff ]);
  let deviceId = JSON.parse(fs.readFileSync(Path.join(certsFolder, 'device-ids.json'), 'utf-8'));
  let manufacturerUUID = new UUID(deviceId['manufacturer-uuid']).toBuffer();
  let deviceClassUUID = new UUID(deviceId['device-class-uuid']).toBuffer();

  let manifest = Buffer.concat([ sigLength, signature, manufacturerUUID, deviceClassUUID, versionBuffer, isDiffBuffer ]);
  return manifest;
}

function _readManifest(file) {
  const FOTA_SIGNATURE_LENGTH = 1 + 72 + 16 + 16 + 4 + 4;
  //total size of signature
  //       1: lenght
  //      72: sig ( + padding ?)
  //      16: uuid manu
  //      16: uuid device
  //       4: u32 version encoded
  //       4: u32 diffbuffer


  if (!fs.existsSync(file)) {
      console.log(file, 'does not exist');
      process.exit(1);
  }


  let readfile = fs.readFileSync(file);
  let readMani = readfile.slice(readfile.length-FOTA_SIGNATURE_LENGTH)
  
  let offset = 0;
  let readMani_sigLength  = parseInt(readMani.slice(0,1).toString('hex') , 16); //stored as value
  offset++;
  let readMani_sig        = readMani.slice(offset,offset+readMani_sigLength).toString('hex'); //stored as hex string
  offset+=72;
  let readMani_manuUUID   = readMani.slice(offset,offset+16).toString('hex'); //stored as hex string
  offset+=16;
  let readMani_deviceUUID = readMani.slice(offset,offset+16).toString('hex'); //stored as hex string
  offset+=16;
  let readMani_versionBuf = readMani.slice(offset,offset+4);
  offset+=4;
  let readMani_isDiff     = readMani.slice(offset,offset+4);
  offset+=4;

  console.log('-----------------------------------');
  console.log('The file signature length is : ' + readMani_sigLength);
  console.log('hex signature of file id : ');
  console.log(readMani_sig);
  console.log('-----------------------------------');
  console.log('manuUUID is    : ' + readMani_manuUUID);
  console.log('deviceUUID is  : ' + readMani_deviceUUID);
  console.log('-----------------------------------');
  //console.log(readMani_versionBuf[3]<<24);
  //console.log(readMani_versionBuf[2]<<16);
  //console.log(readMani_versionBuf[1]<<8);
  //console.log(readMani_versionBuf[0]);
  let versionPatch = (readMani_versionBuf[0] + (readMani_versionBuf[1]<<8) + (readMani_versionBuf[2]<<16) + (readMani_versionBuf[3]<<24));
  console.log('Bin version : ' + versionPatch);

  if (readMani_isDiff[0] == 0){
    console.log('This is a full binary, not a patch');
  }else if (readMani_isDiff[0] == 1){
    console.log('This is a JDIFF patch');
    let versionSize = ((readMani_isDiff[3]) + (readMani_isDiff[2]<<8) + (readMani_isDiff[1]<<16));
    console.log('Old binary size should be : ' + versionSize + ' bytes');
  }else if (readMani_isDiff[0] == 2){
    console.log('This is a DDELTA patch');
    let versionSize = ((readMani_isDiff[3]) + (readMani_isDiff[2]<<8) + (readMani_isDiff[1]<<16));
    console.log('Old binary size should be : ' + versionSize + ' bytes');
  }else{
    console.log('The patch type has not been recognised');
  }
}

function _sign(file) {
  if (!fs.existsSync(certsFolder)) {
    console.log(certsFolder, `folder does not exist, run 'lorawan-fota-signing-tool create-keypair' first`);
    process.exit(1);
  }

  if (!fs.existsSync(file)) {
    console.log(file, 'does not exist');
    process.exit(1);
  }

  let signature = spawnSync('openssl', [
    'dgst', '-sha256', '-sign', Path.join(certsFolder, 'update.key'), file
  ]);
  if (signature.status !== 0) {
    console.log('Signing binary failed', signature.status);
    console.log(signature.stdout.toString('utf-8'));
    console.log(signature.stderr.toString('utf-8'));
    process.exit(1);
  }

  let sig = signature.stdout;

  console.log('Signed signature is', sig.toString('hex'));

  return sig;
}

function _packets_plain(options, bin, outFile) {
  let [ header, fragments ] = _create_packets(options, bin);

  let packets = [ header ].concat(fragments);

  let data = packets.map(p => {
    return p.map(b => {
      let s = b.toString(16);
      if (s.length === 1) s = '0' + s;
      return s;
    }).join(' ')
  }).join('\n');

  fs.writeFileSync(outFile, data, 'utf-8');
  console.log('Written to', outFile);
}

function _packets_h(options, bin, outFile) {
  let [ header, fragments ] = _create_packets(options, bin);
let packetsData = `#ifndef PACKETS_H
#define PACKETS_H

#include "mbed.h"

const uint8_t FAKE_PACKETS_HEADER[] = { ${header.map(n => '0x' + n.toString(16)).join(', ')} };

const uint8_t FAKE_PACKETS[][${fragments[0].length}] = {
`;

for (let f of fragments) {
    packetsData += '    { ' + f.map(c => '0x' + c.toString(16)).join(', ') + ' },\n';
}
packetsData += `};

#endif
`;

  fs.writeFileSync(outFile, packetsData, 'utf-8');
  console.log('Written to', outFile);
}

function _create_packets(options, bin) {
  // outFile
  if (typeof options.redundancyPackets === 'undefined') {
    console.log('\n--redundancy-packets required\n');
    program.help();
  }

  if (typeof options.fragSize === 'undefined') {
    console.log('\n--frag-size required\n');
    program.help();
  }

  // store somewhere in temp
  let tempFile = Path.join(os.tmpdir(), Date.now() + '.bin');
  fs.writeFileSync(tempFile, bin);

  const infileP = spawnSync('python', [
    Path.join(__dirname, 'encode_file.py'),
    tempFile,
    options.fragSize,
    options.redundancyPackets
  ]);
  if (infileP.status !== 0) {
    console.log('Encoding packet failed', infileP.status);
    console.log(infileP.stdout.toString('utf-8'));
    console.log(infileP.stderr.toString('utf-8'));
    process.exit(1);
  }

  let infile = infileP.stdout.toString('utf-8').split('\n');
  let header;
  let fragments = [];

  for (let line of infile) {
    if (line.indexOf('Fragmentation header likely') === 0) {
      header = line.replace('Fragmentation header likely: ', '').match(/\b0x(\w\w)\b/g).map(n => parseInt(n));
    }

    else if (line.indexOf('[8, ') === 0) {
      fragments.push(line.replace('[', '').replace(']', '').split(',').map(n => Number(n)));
    }
  }

  // set padding
  let sz = fs.statSync(tempFile).size;
  if (sz % options.fragSize === 0) {
    header[6] = 0;
  }
  else {
    header[6] = options.fragSize - (sz % options.fragSize);
  }

  // also fragment header is wrong...
  for (let f of fragments) {
    [f[1], f[2]] = [f[2], f[1]];
  }

  fs.unlinkSync(tempFile);

  return [ header, fragments ];
}

program
  .command('create-frag-packets')
  .description('create fragmentation packets')
  .requiredOption('-i, --in-file <file>', 'Input file')
  .addOption(new Option('-f, --output-format <format>', 'Output format')
                .choices(['plain', 'h']).makeOptionMandatory(true))
  .requiredOption('-o, --out-file <file>', 'Output file')
  .requiredOption('--frag-size <number>', 'Fragmentation size (only when output-format is set to packets-*)', myParseInt)
  .requiredOption('--redundancy-packets <number>', 'Number of redundancy packets (only when output-format is set to packets-*)', myParseInt)
  .allowUnknownOption(false)
  .showHelpAfterError(true)
  .action((options) => {
    switch (options.outputFormat) {
      case 'plain':
        return _packets_plain(options, fs.readFileSync(options.inFile), options.outFile);

      case 'h':
        return _packets_h(options, fs.readFileSync(options.inFile), options.outFile);
    }
  });

program.parse(process.argv);
