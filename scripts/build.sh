#!/usr/bin/env bash
# Bundle the browser widget and the vendored manim-web into one ES module.
# MyST copies a widget's `esm` as a single file, so everything it imports at
# load time must be inside it. Large chunks that manim-web only loads on demand
# for features the thesis does not use (MathJax LaTeX, PDF/PPTX slide export,
# Lottie, 3D model loaders, Typst-in-browser, post-processing) stay external: if
# a scene ever uses one, the browser fails to fetch it and the scene shows an error.
# Needs esbuild on PATH (the thesis' pixi envs have it).
set -euo pipefail
cd "$(dirname "$0")/.."
EXTERNAL=(
  './MathJaxBundle-*' './jspdf.es.min-*' './lottie-*' './html2canvas-*'
  './GLTFLoader-*' './OBJLoader-*' './MTLLoader-*' './BokehPass-*'
  './UnrealBloomPass-*' './EffectComposer-*' './RenderPass-*' './OutputPass-*'
  './ShaderPass-*' './wasm-pack-shim-*' './compiler-*' './global-compiler-*'
  './global-renderer-*' './purify.es-*' './index.es-*'
)
args=()
for e in "${EXTERNAL[@]}"; do args+=("--external:$e"); done
esbuild manim-widget.mjs --bundle --format=esm --minify --legal-comments=eof \
  --outfile=dist/manim-widget.bundle.mjs "${args[@]}" "$@"

# MathJax (LaTeX for MathTex) is a 12 MB chunk. It stays a separate file that
# MyST copies into the site (the directive lists it as a model `$asset`), and the
# widget tells manim-web its URL through globalThis.__manimMathJaxUrl. The fixed
# relative import would not work, because MyST renames the widget file.
MJ="$(cd vendor/manim-web && ls MathJaxBundle-*.js)"
sed -i "s#import(\"./${MJ}\")#import(globalThis.__manimMathJaxUrl||\"./${MJ}\")#" dist/manim-widget.bundle.mjs
grep -q "__manimMathJaxUrl" dist/manim-widget.bundle.mjs || { echo "build.sh: MathJax import not rewritten" >&2; exit 1; }
