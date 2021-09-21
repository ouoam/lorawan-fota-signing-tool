#!/usr/bin/python
import sys

# https://github.com/ARMmbed/mbed-lorawan-update-client/blob/master/fragmentation/source/FragmentationMath.cpp
# https://github.com/brocaar/lorawan/blob/master/applayer/fragmentation/encode.go

def prbs23(x):
  b0 = x & 1
  b1 = (x >> 5) & 1
  return (x // 2) + ((b0 ^ b1) << 22)

def is_power_2(num):
  return num != 0 and ((num & (num - 1)) == 0)

def matrix_line(line_number, line_length):
  matrix_line = [0] * line_length # array with line_length number of zero's

  m = 0
  if is_power_2(line_length):
    m = 1

  x = 1 + (1001 * line_number)

  for nbCoeff in range(line_length // 2):
    r = 1 << 16
    while r >= line_length:
      x = prbs23(x)
      r = x % (line_length + m)
    matrix_line[r] = 1

  return matrix_line


def main (infile, fragment_size, redundancy):
  fragment_size = int(fragment_size)
  redundancy = int(redundancy)

  binaryarray = b''
  with open(infile, "rb") as f:
    binaryarray = f.read()

  if (len(binaryarray) % fragment_size) != 0:
    binaryarray += b'\0' * (fragment_size - (len(binaryarray) % fragment_size))

  data = list(binaryarray)

  rowcount = len(data) // fragment_size

  # split into rows of size fragment_size
  data_rows = [data[i : i + fragment_size] for i in range(0, len(data), fragment_size)]
  data_row_count = len(data_rows)

  #build redundancy lines
  for i in range(redundancy):
    newrow = [0] * fragment_size
    templine = matrix_line(i+1, data_row_count)

    for k in range(data_row_count):
      if templine[k] == 1:
        for m in range(fragment_size):
          newrow[m] ^= data_rows[k][m]

    data_rows.append(newrow)

  for u in range(data_row_count + redundancy):
    fcnt = u + 1
    temp = [8, (fcnt >> 8) & 0xFF, fcnt & 0xFF]
    data_rows[u] = temp + data_rows[u]

  datarowsstring_LOW = "0x%02X" % (data_row_count & 0xFF)
  datarowsstring_HIGH = "0x%02X" % ((data_row_count >> 8) & 0xFF)
  fragmentsizestring = "0x%02X" % fragment_size
  print ("Fragmentation header likely: [  0x02, 0x00, "+datarowsstring_LOW+", "+ datarowsstring_HIGH +", "+fragmentsizestring+", 0x00, 0x00, 0x00, 0x00, 0x00, 0x00 ]")
  for line in data_rows:
    print(line)


if __name__ == "__main__":
  argv = sys.argv[1:]

  if len(argv) != 3:
    print ("encode_file.py infile.bin fragment_size redundant_lines")
    exit()

  main(argv[0], argv[1], argv[2])
