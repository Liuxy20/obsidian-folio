import { deflateSync } from 'node:zlib';

// Deterministic noisy raster, about 720 KB; real PNG decode is tested in Electron.
export function largePNG() {
  const crc = bytes => { let n = 0xffffffff; for (const b of bytes) { n ^= b; for (let i=0;i<8;i++) n = (n>>>1)^((n&1)?0xedb88320:0); } return (n^0xffffffff)>>>0; };
  const chunk = (name, bytes) => { const label=Buffer.from(name), size=Buffer.alloc(4), sum=Buffer.alloc(4); size.writeUInt32BE(bytes.length); sum.writeUInt32BE(crc(Buffer.concat([label,bytes]))); return Buffer.concat([size,label,bytes,sum]); };
  const width=600,height=400, rows=Buffer.alloc(height*(1+width*3)); let seed=12345;
  for(let y=0;y<height;y++) for(let x=1;x<=width*3;x++) { seed^=seed<<13;seed^=seed>>>17;seed^=seed<<5;rows[y*(1+width*3)+x]=seed&255; }
  const header=Buffer.alloc(13);header.writeUInt32BE(width,0);header.writeUInt32BE(height,4);header[8]=8;header[9]=2;
  return Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]),chunk('IHDR',header),chunk('IDAT',deflateSync(rows)),chunk('IEND',Buffer.alloc(0))]);
}
