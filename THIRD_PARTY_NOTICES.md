# Third-party notices

LocalLeaf Community includes open-source components written and maintained by other people. We are grateful for that work and keep their licensing information with every distributed build.

The VSIX retains the license files shipped by its runtime dependencies. The notices below are reproduced as well for components whose upstream notice is stored in a file excluded from the packaged dependency, whose package has no standalone license file, or whose code is bundled into the community website.

Versions in this document reflect the dependency locks reviewed before the first LocalLeaf Community release.

## Components covered by the MIT License below

- `balanced-match` 1.0.2 — Copyright (c) 2013 Julian Gruber `<julian@juliangruber.com>`
- `node-fetch` 2.7.0 — Copyright (c) 2016 David Frank
- `socket.io-client` 0.9.17-overleaf-5 — Copyright (c) 2010 LearnBoost `<dev@learnboost.com>`; this is the MIT-licensed Overleaf fork of the original Socket.IO client
- `tr46` 0.0.3 — Copyright (c) 2016 Sebastian Mayr
- `react` 19.2.3, `react-dom` 19.2.3, and `scheduler` 0.27.0 — Copyright (c) Meta Platforms, Inc. and affiliates

MIT License

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.

## webidl-conversions 3.0.1

BSD 2-Clause License

Copyright (c) 2014, Domenic Denicola
All rights reserved.

Redistribution and use in source and binary forms, with or without modification, are permitted provided that the following conditions are met:

1. Redistributions of source code must retain the above copyright notice, this list of conditions and the following disclaimer.

2. Redistributions in binary form must reproduce the above copyright notice, this list of conditions and the following disclaimer in the documentation and/or other materials provided with the distribution.

THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS "AS IS" AND ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE ARE DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT HOLDER OR CONTRIBUTORS BE LIABLE FOR ANY DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR CONSEQUENTIAL DAMAGES (INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR SERVICES; LOSS OF USE, DATA, OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER CAUSED AND ON ANY THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY, OR TORT (INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE OF THIS SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.

## Other extension runtime dependencies

The following runtime packages keep their own upstream license files inside the VSIX:

- MIT: `asynckit`, `async-limiter`, `call-bind-apply-helpers`, `combined-stream`, `delayed-stream`, `dunder-proto`, `es-define-property`, `es-errors`, `es-object-atoms`, `es-set-tostringtag`, `form-data`, `function-bind`, `get-intrinsic`, `get-proto`, `gopd`, `hasown`, `has-symbols`, `has-tostringtag`, `math-intrinsics`, `mime-db`, `mime-types`, `whatwg-url`, `ws`, and `xmlhttprequest`
- ISC: `minimatch`
- MIT: `brace-expansion`, included as a transitive dependency of `minimatch`

## Website fonts

The website requests `Press Start 2P` and `VT323` from Google Fonts. They are not bundled in this repository or in the website build. Both fonts are made available by their authors under the SIL Open Font License 1.1 through Google Fonts.

This notice does not change the license of LocalLeaf Community itself. The project license and its own copyright notices are in [LICENSE](LICENSE).
