all: c29s.js

c29s.js:
	emcc cuckaroo29s.c blake2b-ref.c  -o c29s.js  -s EXTRA_EXPORTED_RUNTIME_METHODS='["ccall", "cwrap"]' -s WASM=1

