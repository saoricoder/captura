$model = "Xenova/whisper-tiny.en"
$baseUrl = "https://huggingface.co/$model/resolve/main"
$outDir = "models/$model"

New-Item -ItemType Directory -Force -Path $outDir | Out-Null
New-Item -ItemType Directory -Force -Path "$outDir/onnx" | Out-Null

$files = @(
    "config.json",
    "preprocessor_config.json",
    "tokenizer_config.json",
    "tokenizer.json",
    "vocab.json",
    "special_tokens_map.json",
    "generation_config.json",
    "onnx/config.json",
    "onnx/encoder_model.onnx",
    "onnx/decoder_model_merged.onnx",
    "onnx/encoder_model_quantized.onnx",
    "onnx/decoder_model_merged_quantized.onnx",
    "onnx/generation_config.json"
)

foreach ($f in $files) {
    $url = "$baseUrl/$f"
    $dest = "$outDir/$f"
    Write-Host "Downloading $f..."
    try {
        Invoke-WebRequest -Uri $url -OutFile $dest -ErrorAction Stop
    } catch {
        Write-Host "Failed or skipped ${f}: $_"
    }
}
Write-Host "Done!"
