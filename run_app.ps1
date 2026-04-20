param(
    [ValidateSet("android", "ios", "none")]
    [string]$Platform = "android",
    [string]$BackendHost = "0.0.0.0",
    [int]$BackendPort = 8000,
    [switch]$SkipInstall,
    [switch]$CleanInstall
)

$ErrorActionPreference = "Stop"

function Assert-Command {
    param([Parameter(Mandatory = $true)][string]$Name)

    if (-not (Get-Command $Name -ErrorAction SilentlyContinue)) {
        throw "Required command '$Name' was not found in PATH."
    }
}

function Invoke-ExternalChecked {
    param(
        [Parameter(Mandatory = $true)][string]$Executable,
        [Parameter(Mandatory = $true)][string[]]$Arguments,
        [Parameter(Mandatory = $true)][string]$Description
    )

    & $Executable @Arguments
    if ($LASTEXITCODE -ne 0) {
        throw "$Description failed (exit code: $LASTEXITCODE)."
    }
}

function Start-DetachedPowerShell {
    param(
        [Parameter(Mandatory = $true)][string]$Command,
        [Parameter(Mandatory = $true)][string]$Title
    )

    $safeTitle = $Title.Replace("'", "''")
    $wrapped = @"
`$Host.UI.RawUI.WindowTitle = '$safeTitle'
$Command
"@

    $encoded = [Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($wrapped))
    Start-Process -FilePath "powershell.exe" -ArgumentList "-NoExit", "-EncodedCommand", $encoded | Out-Null
}

function Remove-PathIfExists {
    param([Parameter(Mandatory = $true)][string]$Path)

    if (Test-Path -LiteralPath $Path) {
        Write-Host "Removing $Path" -ForegroundColor DarkYellow
        Remove-Item -LiteralPath $Path -Recurse -Force
    }
}

function Get-VenvPython {
    param([Parameter(Mandatory = $true)][string]$VenvDir)

    $isWindowsHost = ($env:OS -eq "Windows_NT")
    if ($isWindowsHost) {
        # On Windows we explicitly prefer the standard venv layout.
        $candidates = @(
            (Join-Path $VenvDir "Scripts\\python.exe"),
            (Join-Path $VenvDir "Scripts\\python"),
            (Join-Path $VenvDir "python.exe"),
            (Join-Path $VenvDir "python")
        )
    }
    else {
        $candidates = @(
            (Join-Path $VenvDir "bin\\python"),
            (Join-Path $VenvDir "bin\\python3"),
            (Join-Path $VenvDir "bin\\python.exe"),
            (Join-Path $VenvDir "bin\\python3.exe"),
            (Join-Path $VenvDir "python.exe"),
            (Join-Path $VenvDir "python")
        )
    }

    return $candidates | Where-Object {
        Test-Path -LiteralPath $_
    } | Select-Object -First 1
}

function Get-RequirementPackageNames {
    param([Parameter(Mandatory = $true)][string]$RequirementsPath)

    if (-not (Test-Path -LiteralPath $RequirementsPath)) {
        return @()
    }

    $lines = Get-Content -LiteralPath $RequirementsPath
    $packages = New-Object System.Collections.Generic.List[string]

    foreach ($rawLine in $lines) {
        $line = $rawLine.Trim()
        if ([string]::IsNullOrWhiteSpace($line)) {
            continue
        }
        if ($line.StartsWith("#")) {
            continue
        }
        if ($line.StartsWith("-r ") -or $line.StartsWith("--requirement ")) {
            continue
        }
        if ($line.StartsWith("-e ") -or $line.StartsWith("--editable ")) {
            continue
        }

        if ($line.Contains("#")) {
            $line = $line.Split("#")[0].Trim()
        }
        if ($line.Contains(";")) {
            $line = $line.Split(";")[0].Trim()
        }
        if ([string]::IsNullOrWhiteSpace($line)) {
            continue
        }

        $match = [regex]::Match($line, "^([A-Za-z0-9._-]+)")
        if (-not $match.Success -or $match.Groups.Count -lt 2) {
            continue
        }

        $pkg = $match.Groups[1].Value
        if (-not $packages.Contains($pkg)) {
            $packages.Add($pkg)
        }
    }

    return $packages
}

function Get-MobileRequiredPackages {
    param([Parameter(Mandatory = $true)][string]$MobileDir)

    $packageJsonPath = Join-Path $MobileDir "package.json"
    if (-not (Test-Path -LiteralPath $packageJsonPath)) {
        throw "Missing mobile package.json at $packageJsonPath"
    }

    $packageJsonRaw = Get-Content -LiteralPath $packageJsonPath -Raw
    $convertFromJson = Get-Command ConvertFrom-Json -ErrorAction Stop
    if ($convertFromJson.Parameters.ContainsKey("AsHashtable")) {
        $pkg = $packageJsonRaw | ConvertFrom-Json -AsHashtable
    }
    else {
        $pkg = $packageJsonRaw | ConvertFrom-Json
    }

    $dependencies = @{}
    $dependencySource = $null
    if ($pkg -is [System.Collections.IDictionary]) {
        if ($pkg.Contains("dependencies")) {
            $dependencySource = $pkg["dependencies"]
        }
    }
    elseif ($pkg.PSObject.Properties.Name -contains "dependencies") {
        $dependencySource = $pkg.dependencies
    }

    if ($dependencySource -is [System.Collections.IDictionary]) {
        foreach ($name in $dependencySource.Keys) {
            $nameAsString = [string]$name
            if (-not [string]::IsNullOrWhiteSpace($nameAsString)) {
                $dependencies[$nameAsString] = [string]$dependencySource[$name]
            }
        }
    }
    elseif ($dependencySource) {
        foreach ($prop in $dependencySource.PSObject.Properties) {
            $nameAsString = [string]$prop.Name
            if (-not [string]::IsNullOrWhiteSpace($nameAsString)) {
                $dependencies[$nameAsString] = [string]$prop.Value
            }
        }
    }

    $requiredNameSet = @{}
    foreach ($name in $dependencies.Keys) {
        if (-not [string]::IsNullOrWhiteSpace([string]$name)) {
            $requiredNameSet[[string]$name] = $true
        }
    }

    foreach ($mustHave in @(
        "expo",
        "react-native",
        "react-native-vision-camera",
        "react-native-worklets-core",
        "react-native-vision-camera-mlkit"
    )) {
        $requiredNameSet[$mustHave] = $true
    }

    $result = @()
    foreach ($name in ($requiredNameSet.Keys | Sort-Object)) {
        $versionSpec = $null
        if ($dependencies.ContainsKey($name)) {
            $versionSpec = $dependencies[$name]
        }

        $result += [PSCustomObject]@{
            Name = $name
            VersionSpec = $versionSpec
        }
    }

    return $result
}

function Test-MobileRequiredPackagesInstalled {
    param([Parameter(Mandatory = $true)][string]$MobileDir)

    $required = Get-MobileRequiredPackages -MobileDir $MobileDir
    $missing = @()

    foreach ($pkg in $required) {
        $pkgJsonPath = Join-Path $MobileDir ("node_modules\\{0}\\package.json" -f $pkg.Name)
        if (-not (Test-Path -LiteralPath $pkgJsonPath)) {
            $missing += $pkg
        }
    }

    return [PSCustomObject]@{
        AllInstalled = ($missing.Count -eq 0)
        Missing = @($missing)
    }
}

function Ensure-MobileDependencies {
    param(
        [Parameter(Mandatory = $true)][string]$MobileDir,
        [Parameter(Mandatory = $true)][bool]$ForceInstall
    )

    Push-Location $MobileDir
    try {
        if ($ForceInstall) {
            Invoke-ExternalChecked -Executable "cmd" -Arguments @("/c", "npm", "install") -Description "Install mobile dependencies"
        }

        $status = Test-MobileRequiredPackagesInstalled -MobileDir $MobileDir
        if (-not $status.AllInstalled) {
            $missing = @($status.Missing)
            $names = $missing | ForEach-Object { $_.Name }
            Write-Host ("Mobile deps missing: " + ($names -join ", ")) -ForegroundColor Yellow
            Write-Host "Installing missing mobile packages..." -ForegroundColor Yellow

            $installTargets = @()
            foreach ($item in $missing) {
                if ($item.VersionSpec -and -not [string]::IsNullOrWhiteSpace($item.VersionSpec)) {
                    $installTargets += ("$($item.Name)@$($item.VersionSpec)")
                }
                else {
                    $installTargets += [string]$item.Name
                }
            }

            Invoke-ExternalChecked -Executable "cmd" -Arguments (@("/c", "npm", "install", "--save") + @($installTargets)) -Description "Install missing mobile packages"
        }
    }
    finally {
        Pop-Location
    }
}

function Ensure-VisionCameraAndroidDevicePatch {
    param([Parameter(Mandatory = $true)][string]$MobileDir)

    $cameraDevicesManagerPath = Join-Path $MobileDir "node_modules\react-native-vision-camera\android\src\main\java\com\mrousavy\camera\react\CameraDevicesManager.kt"
    $cameraDeviceDetailsPath = Join-Path $MobileDir "node_modules\react-native-vision-camera\android\src\main\java\com\mrousavy\camera\core\CameraDeviceDetails.kt"
    if (-not (Test-Path -LiteralPath $cameraDevicesManagerPath) -or -not (Test-Path -LiteralPath $cameraDeviceDetailsPath)) {
        Write-Host "VisionCamera Android source not found yet (skip native patch)." -ForegroundColor DarkYellow
        return
    }

    $patchedAny = $false

    $detailsContent = Get-Content -LiteralPath $cameraDeviceDetailsPath -Raw
    $detailsUpdated = $detailsContent
    if (-not $detailsUpdated.Contains("extensionsManager: ExtensionsManager? = null")) {
        $detailsUpdated = $detailsUpdated.Replace(
            "class CameraDeviceDetails(private val cameraInfo: CameraInfo, extensionsManager: ExtensionsManager) {",
            "class CameraDeviceDetails(private val cameraInfo: CameraInfo, extensionsManager: ExtensionsManager? = null) {"
        )
    }
    if ($detailsUpdated.Contains("extensionsManager.isExtensionAvailable(cameraInfo.cameraSelector, ExtensionMode.HDR)")) {
        $detailsUpdated = $detailsUpdated.Replace(
            "private val supportsHdrExtension = extensionsManager.isExtensionAvailable(cameraInfo.cameraSelector, ExtensionMode.HDR)",
            "private val supportsHdrExtension = extensionsManager?.isExtensionAvailable(cameraInfo.cameraSelector, ExtensionMode.HDR) ?: false"
        )
    }
    if ($detailsUpdated.Contains("extensionsManager.isExtensionAvailable(cameraInfo.cameraSelector, ExtensionMode.NIGHT)")) {
        $detailsUpdated = $detailsUpdated.Replace(
            "private val supportsLowLightBoostExtension = extensionsManager.isExtensionAvailable(cameraInfo.cameraSelector, ExtensionMode.NIGHT)",
            "private val supportsLowLightBoostExtension = extensionsManager?.isExtensionAvailable(cameraInfo.cameraSelector, ExtensionMode.NIGHT) ?: false"
        )
    }
    if ($detailsUpdated -ne $detailsContent) {
        Set-Content -LiteralPath $cameraDeviceDetailsPath -Value $detailsUpdated -NoNewline
        Write-Host "Applied VisionCamera Android extension-fallback patch." -ForegroundColor Cyan
        $patchedAny = $true
    }

    $managerContent = Get-Content -LiteralPath $cameraDevicesManagerPath -Raw
    $managerUpdated = $managerContent

    if ($managerUpdated.Contains("val extensionsManager = extensionsManager ?: return devices")) {
        $managerUpdated = $managerUpdated.Replace(
            "val extensionsManager = extensionsManager ?: return devices",
            "val extensionsManager = extensionsManager"
        )
    }

    $marker = "dataset-capture-app: emit refresh after camera provider init"
    if (-not $managerUpdated.Contains($marker)) {
        $needle = '        Log.i(TAG, "Successfully initialized!")'
        if ($managerUpdated.Contains($needle)) {
            $replacement = @'
        Log.i(TAG, "Successfully initialized!")
        // dataset-capture-app: emit refresh after camera provider init
        if (reactContext.hasActiveReactInstance()) {
          sendAvailableDevicesChangedEvent()
        }
'@
            $managerUpdated = $managerUpdated.Replace($needle, $replacement)
        }
        else {
            Write-Host "Could not patch VisionCamera device refresh hook (unexpected source layout)." -ForegroundColor DarkYellow
        }
    }

    if ($managerUpdated -ne $managerContent) {
        Set-Content -LiteralPath $cameraDevicesManagerPath -Value $managerUpdated -NoNewline
        Write-Host "Applied VisionCamera Android device refresh patch." -ForegroundColor Cyan
        $patchedAny = $true
    }

    if (-not $patchedAny) {
        Write-Host "VisionCamera Android patch already applied." -ForegroundColor DarkGray
    }
}

function Ensure-AndroidPoseDetectorPlugin {
    param([Parameter(Mandatory = $true)][string]$MobileDir)

    $androidJavaRoot = Join-Path $MobileDir "android\app\src\main\java"
    if (-not (Test-Path -LiteralPath $androidJavaRoot)) {
        Write-Host "Android source tree not found. Skipping native pose plugin patch." -ForegroundColor DarkYellow
        return
    }

    $mainApplication = Get-ChildItem -Path $androidJavaRoot -Filter "MainApplication.kt" -Recurse -ErrorAction SilentlyContinue | Select-Object -First 1
    if (-not $mainApplication) {
        Write-Host "MainApplication.kt not found. Skipping native pose plugin patch." -ForegroundColor DarkYellow
        return
    }

    $mainApplicationPath = $mainApplication.FullName
    $mainContent = Get-Content -LiteralPath $mainApplicationPath -Raw
    $packageMatch = [regex]::Match($mainContent, "(?m)^\s*package\s+([A-Za-z0-9_.]+)\s*$")
    if (-not $packageMatch.Success) {
        Write-Host "Could not determine Android package name from MainApplication.kt." -ForegroundColor DarkYellow
        return
    }

    $packageName = $packageMatch.Groups[1].Value
    $packagePath = $packageName -replace "\.", "\"
    $packageDir = Join-Path $androidJavaRoot $packagePath
    $pluginDir = Join-Path $packageDir "plugins"
    New-Item -ItemType Directory -Path $pluginDir -Force | Out-Null

    $pluginPath = Join-Path $pluginDir "PoseDetectionFrameProcessorPlugin.kt"
    $pluginContent = @"
package $packageName.plugins

import com.google.android.gms.tasks.Tasks
import com.google.mlkit.vision.common.InputImage
import com.google.mlkit.vision.pose.PoseDetection
import com.google.mlkit.vision.pose.defaults.PoseDetectorOptions
import com.mrousavy.camera.core.types.Orientation
import com.mrousavy.camera.frameprocessors.Frame
import com.mrousavy.camera.frameprocessors.FrameProcessorPlugin
import com.mrousavy.camera.frameprocessors.FrameProcessorPluginRegistry
import com.mrousavy.camera.frameprocessors.VisionCameraProxy
import kotlin.math.max

@Suppress("UNCHECKED_CAST")
class PoseDetectionFrameProcessorPlugin(
  @Suppress("unused") private val proxy: VisionCameraProxy,
  options: Map<String, Any>?,
) : FrameProcessorPlugin() {
  private val detector =
    PoseDetection.getClient(
      PoseDetectorOptions
        .Builder()
        .setDetectorMode(parseDetectorMode(options))
        .build(),
    )

  override fun callback(
    frame: Frame,
    params: Map<String, Any>?,
  ): Any? {
    val modeOverride = (params?.get("mode") as? String)?.lowercase()
    if (modeOverride == "single") {
      // Kept for API compatibility; detector remains in stream mode.
    }

    val mediaImage = frame.image
    val rotationDegrees = toInputImageRotationDegrees(frame)
    val inputImage = InputImage.fromMediaImage(mediaImage, rotationDegrees)
    val pose = Tasks.await(detector.process(inputImage))

    if (pose.allPoseLandmarks.isEmpty()) {
      return null
    }

    val rawWidth = inputImage.width.toDouble().coerceAtLeast(1.0)
    val rawHeight = inputImage.height.toDouble().coerceAtLeast(1.0)
    val needsSwap = rotationDegrees == 90 || rotationDegrees == 270
    val width = if (needsSwap) rawHeight else rawWidth
    val height = if (needsSwap) rawWidth else rawHeight
    val zScale = max(width, height)

    val output = ArrayList<ArrayList<Double>>(33)
    for (index in 0 until 33) {
      output.add(arrayListOf(0.0, 0.0, 0.0, 0.0))
    }

    for (landmark in pose.allPoseLandmarks) {
      val type = landmark.landmarkType
      if (type < 0 || type >= output.size) {
        continue
      }

      val position = landmark.position
      val normalizedX = (position.x.toDouble() / width).coerceIn(0.0, 1.0)
      val normalizedY = (position.y.toDouble() / height).coerceIn(0.0, 1.0)
      val normalizedZ = extractLandmarkZ(landmark) / zScale
      val visibility = landmark.inFrameLikelihood.toDouble().coerceIn(0.0, 1.0)

      val tuple = output[type]
      tuple[0] = normalizedX
      tuple[1] = normalizedY
      tuple[2] = normalizedZ
      tuple[3] = visibility
    }

    return hashMapOf(
      "keypoints" to output,
      "sourceWidth" to width,
      "sourceHeight" to height,
      "isMirrored" to frame.isMirrored,
      "rotationDegrees" to rotationDegrees,
    )
  }

  private fun parseDetectorMode(options: Map<String, Any>?): Int {
    val mode = (options?.get("mode") as? String)?.lowercase()
    return if (mode == "single") {
      PoseDetectorOptions.SINGLE_IMAGE_MODE
    } else {
      PoseDetectorOptions.STREAM_MODE
    }
  }

  private fun toInputImageRotationDegrees(frame: Frame): Int {
    // VisionCamera Frame.orientation is reversed from CameraX imageInfo.rotationDegrees.
    // Convert it back to MLKit's expected rotation degrees.
    return when (frame.orientation) {
      Orientation.PORTRAIT -> 0
      Orientation.LANDSCAPE_RIGHT -> 90
      Orientation.PORTRAIT_UPSIDE_DOWN -> 180
      Orientation.LANDSCAPE_LEFT -> 270
    }
  }

  private fun extractLandmarkZ(landmark: Any): Double {
    return try {
      val getPosition3D = landmark.javaClass.methods.firstOrNull { method ->
        method.name == "getPosition3D" && method.parameterCount == 0
      } ?: return 0.0
      val point3D = getPosition3D.invoke(landmark) ?: return 0.0
      val getZ = point3D.javaClass.methods.firstOrNull { method ->
        method.name == "getZ" && method.parameterCount == 0
      } ?: return 0.0
      val zValue = getZ.invoke(point3D) as? Number ?: return 0.0
      zValue.toDouble()
    } catch (_: Throwable) {
      0.0
    }
  }

  companion object {
    @Volatile
    private var registered = false

    @JvmStatic
    fun registerPlugins() {
      if (registered) {
        return
      }
      synchronized(this) {
        if (registered) {
          return
        }

        try {
          FrameProcessorPluginRegistry.addFrameProcessorPlugin("poseDetection") { proxy, options ->
            PoseDetectionFrameProcessorPlugin(proxy, options as? Map<String, Any>)
          }
        } catch (_: Throwable) {
          // Ignore duplicate registration across hot restarts.
        }

        try {
          FrameProcessorPluginRegistry.addFrameProcessorPlugin("PoseDetection") { proxy, options ->
            PoseDetectionFrameProcessorPlugin(proxy, options as? Map<String, Any>)
          }
        } catch (_: Throwable) {
          // Ignore duplicate registration across hot restarts.
        }

        registered = true
      }
    }
  }
}
"@

    $existingPluginContent = ""
    if (Test-Path -LiteralPath $pluginPath) {
        $existingPluginContent = Get-Content -LiteralPath $pluginPath -Raw
    }
    if ($existingPluginContent -ne $pluginContent) {
        Set-Content -LiteralPath $pluginPath -Value $pluginContent -NoNewline
        Write-Host "Patched native pose plugin source: $pluginPath" -ForegroundColor Cyan
    }

    $importLine = "import $packageName.plugins.PoseDetectionFrameProcessorPlugin"
    $registerCall = "    PoseDetectionFrameProcessorPlugin.registerPlugins()"
    $mainUpdated = $mainContent
    if (-not $mainUpdated.Contains($importLine)) {
        if ($mainUpdated.Contains("import com.facebook.soloader.SoLoader")) {
            $mainUpdated = $mainUpdated.Replace(
                "import com.facebook.soloader.SoLoader",
                "import com.facebook.soloader.SoLoader`r`n$importLine"
            )
        }
    }
    if (-not $mainUpdated.Contains("PoseDetectionFrameProcessorPlugin.registerPlugins()")) {
        if ($mainUpdated.Contains("    SoLoader.init(this, OpenSourceMergedSoMapping)")) {
            $mainUpdated = $mainUpdated.Replace(
                "    SoLoader.init(this, OpenSourceMergedSoMapping)",
                "    SoLoader.init(this, OpenSourceMergedSoMapping)`r`n$registerCall"
            )
        }
        elseif ($mainUpdated.Contains("    ApplicationLifecycleDispatcher.onApplicationCreate(this)")) {
            $mainUpdated = $mainUpdated.Replace(
                "    ApplicationLifecycleDispatcher.onApplicationCreate(this)",
                "$registerCall`r`n    ApplicationLifecycleDispatcher.onApplicationCreate(this)"
            )
        }
    }
    if ($mainUpdated -ne $mainContent) {
        Set-Content -LiteralPath $mainApplicationPath -Value $mainUpdated -NoNewline
        Write-Host "Patched MainApplication pose plugin registration." -ForegroundColor Cyan
    }

    $appBuildGradlePath = Join-Path $MobileDir "android\app\build.gradle"
    if (Test-Path -LiteralPath $appBuildGradlePath) {
        $gradleContent = Get-Content -LiteralPath $appBuildGradlePath -Raw
        if (-not $gradleContent.Contains("com.google.mlkit:pose-detection")) {
            $updatedGradle = $gradleContent
            if ($updatedGradle.Contains('implementation("com.facebook.react:react-android")')) {
                $updatedGradle = $updatedGradle.Replace(
                    'implementation("com.facebook.react:react-android")',
                    "implementation(`"com.facebook.react:react-android`")`r`n    implementation(`"com.google.mlkit:pose-detection:18.0.0-beta5`")"
                )
            }
            elseif ($updatedGradle.Contains("dependencies {")) {
                $updatedGradle = $updatedGradle.Replace(
                    "dependencies {",
                    "dependencies {`r`n    implementation(`"com.google.mlkit:pose-detection:18.0.0-beta5`")"
                )
            }

            if ($updatedGradle -ne $gradleContent) {
                Set-Content -LiteralPath $appBuildGradlePath -Value $updatedGradle -NoNewline
                Write-Host "Patched Android app Gradle dependencies for ML Kit pose." -ForegroundColor Cyan
            }
        }
    }
}

function Test-BackendRequirementsInstalled {
    param(
        [Parameter(Mandatory = $true)][string]$BackendDir,
        [Parameter(Mandatory = $true)][string]$PythonExe
    )

    $requirementsPath = Join-Path $BackendDir "requirements.txt"
    $packages = Get-RequirementPackageNames -RequirementsPath $requirementsPath
    $missing = New-Object System.Collections.Generic.List[string]

    foreach ($pkg in $packages) {
        try {
            & $PythonExe -m pip show $pkg *> $null
            if ($LASTEXITCODE -ne 0) {
                $missing.Add($pkg)
            }
        }
        catch {
            $missing.Add($pkg)
        }
    }

    return [PSCustomObject]@{
        AllInstalled = ($missing.Count -eq 0)
        MissingPackages = @($missing)
    }
}

function Ensure-BackendDependencies {
    param(
        [Parameter(Mandatory = $true)][string]$BackendDir,
        [Parameter(Mandatory = $true)][string]$PythonExe,
        [Parameter(Mandatory = $true)][bool]$ForceInstall
    )

    $hasUvicorn = $false
    try {
        & $PythonExe -m uvicorn --version *> $null
        if ($LASTEXITCODE -eq 0) {
            $hasUvicorn = $true
        }
    }
    catch {
        $hasUvicorn = $false
    }

    $requirementsStatus = Test-BackendRequirementsInstalled -BackendDir $BackendDir -PythonExe $PythonExe
    $missingPackages = @($requirementsStatus.MissingPackages)
    $requirementsMissing = -not $requirementsStatus.AllInstalled

    $shouldInstall = $ForceInstall -or -not $hasUvicorn -or $requirementsMissing
    if ($shouldInstall) {
        if (-not $ForceInstall) {
            if (-not $hasUvicorn) {
                Write-Host "Backend deps missing in venv (uvicorn not found)." -ForegroundColor Yellow
            }
            if ($requirementsMissing) {
                Write-Host ("Backend deps missing in venv: " + ($missingPackages -join ", ")) -ForegroundColor Yellow
            }
            Write-Host "Installing backend requirements into launcher virtualenv..." -ForegroundColor Yellow
        }

        Push-Location $BackendDir
        try {
            if ($ForceInstall) {
                Invoke-ExternalChecked -Executable $PythonExe -Arguments @("-m", "pip", "install", "--upgrade", "pip") -Description "Upgrade backend pip"
            }
            Invoke-ExternalChecked -Executable $PythonExe -Arguments @("-m", "pip", "install", "-r", "requirements.txt") -Description "Install backend requirements"
        }
        finally {
            Pop-Location
        }
    }
}

function Test-PythonVenvCapability {
    param(
        [Parameter(Mandatory = $true)][string]$PythonExe,
        [Parameter(Mandatory = $true)][string]$BackendDir
    )

    if (-not (Test-Path -LiteralPath $PythonExe)) {
        return $false
    }

    $probeDir = Join-Path $BackendDir ".venv_probe_launcher"
    if (Test-Path -LiteralPath $probeDir) {
        Remove-Item -LiteralPath $probeDir -Recurse -Force
    }

    try {
        & $PythonExe -m venv $probeDir *> $null
        if ($LASTEXITCODE -ne 0) {
            return $false
        }
        $probePython = Get-VenvPython -VenvDir $probeDir
        if (-not $probePython) {
            return $false
        }

        & $probePython -m pip --version *> $null
        if ($LASTEXITCODE -ne 0) {
            return $false
        }

        return $true
    }
    catch {
        return $false
    }
    finally {
        if (Test-Path -LiteralPath $probeDir) {
            Remove-Item -LiteralPath $probeDir -Recurse -Force
        }
    }
}

function Get-WorkingPythonForVenv {
    param([Parameter(Mandatory = $true)][string]$BackendDir)

    $candidates = New-Object System.Collections.Generic.List[string]

    function Add-Candidate {
        param([Parameter(Mandatory = $true)][string]$Path)

        if ([string]::IsNullOrWhiteSpace($Path)) {
            return
        }
        if (-not (Test-Path -LiteralPath $Path)) {
            return
        }

        $resolved = (Resolve-Path -LiteralPath $Path).Path
        if (-not $candidates.Contains($resolved)) {
            $candidates.Add($resolved)
        }
    }

    if ($env:PYTHON_FOR_VENV) {
        Add-Candidate -Path $env:PYTHON_FOR_VENV
    }

    $pythonCommands = @(Get-Command python -ErrorAction SilentlyContinue)
    foreach ($pythonCmd in $pythonCommands) {
        if ($pythonCmd -and $pythonCmd.Source) {
            Add-Candidate -Path $pythonCmd.Source
        }
    }

    $pipCmd = Get-Command pip -ErrorAction SilentlyContinue
    if ($pipCmd) {
        $pipVersionOutput = ((& pip --version 2>$null) | Out-String).Trim()
        if ($pipVersionOutput) {
            $match = [regex]::Match(
                $pipVersionOutput,
                " from (.+?)\\Lib\\site-packages\\pip "
            )
            if ($match.Success -and $match.Groups.Count -ge 2) {
                $pythonHome = $match.Groups[1].Value
                $pythonFromPip = Join-Path $pythonHome "python.exe"
                Add-Candidate -Path $pythonFromPip
            }
        }
    }

    if ($env:LOCALAPPDATA) {
        foreach ($version in @("Python313", "Python312", "Python311", "Python310")) {
            $candidate = Join-Path $env:LOCALAPPDATA ("Programs\\Python\\{0}\\python.exe" -f $version)
            Add-Candidate -Path $candidate
        }
    }

    if ($candidates.Count -eq 0) {
        throw "No Python executable candidates found. Install Python 3.10+ and rerun."
    }

    foreach ($candidate in $candidates) {
        Write-Host "Checking Python candidate: $candidate" -ForegroundColor DarkGray
        if (Test-PythonVenvCapability -PythonExe $candidate -BackendDir $BackendDir) {
            Write-Host "Using Python for backend venv: $candidate" -ForegroundColor Green
            return $candidate
        }
    }

    throw "Could not find a Python interpreter that can create a venv with pip."
}

function Ensure-VenvPython {
    param(
        [Parameter(Mandatory = $true)][string]$BackendDir,
        [Parameter(Mandatory = $true)][string]$PythonForVenv
    )

    function Get-PythonMajorMinor {
        param([Parameter(Mandatory = $true)][string]$Exe)
        $version = (& $Exe -c "import sys; print(f'{sys.version_info[0]}.{sys.version_info[1]}')" 2>$null | Out-String).Trim()
        return $version
    }

    $venvDir = Join-Path $BackendDir ".venv"
    $existing = Get-VenvPython -VenvDir $venvDir
    if ($existing) {
        $reuse = $true

        $targetVersion = Get-PythonMajorMinor -Exe $PythonForVenv
        $existingVersion = Get-PythonMajorMinor -Exe $existing
        if ($targetVersion -and $existingVersion -and $targetVersion -ne $existingVersion) {
            Write-Host "Existing venv Python ($existingVersion) differs from selected Python ($targetVersion). Recreating..." -ForegroundColor Yellow
            $reuse = $false
        }

        if ($reuse) {
            & $existing -m pip --version *> $null
            if ($LASTEXITCODE -ne 0) {
                Write-Host "Existing venv has no working pip. Recreating..." -ForegroundColor Yellow
                $reuse = $false
            }
        }

        if ($reuse) {
            return $existing
        }
    }

    if (Test-Path -LiteralPath $venvDir) {
        Write-Host "Found incomplete virtualenv. Recreating..." -ForegroundColor Yellow
        Remove-Item -LiteralPath $venvDir -Recurse -Force
    }

    Write-Host "Creating backend virtualenv..." -ForegroundColor Cyan
    Push-Location $BackendDir
    try {
        Invoke-ExternalChecked -Executable $PythonForVenv -Arguments @("-m", "venv", ".venv") -Description "Create backend virtualenv"
    }
    finally {
        Pop-Location
    }

    $created = Get-VenvPython -VenvDir $venvDir
    if (-not $created) {
        throw "Virtualenv creation failed. Expected Python executable under: $venvDir"
    }
    & $created -m pip --version *> $null
    if ($LASTEXITCODE -ne 0) {
        throw "Virtualenv created but pip is unavailable: $created"
    }
    return $created
}

function Get-AndroidSdkInfo {
    $sdkCandidates = New-Object System.Collections.Generic.List[string]

    function Add-SdkCandidate {
        param([string]$Path)
        if ([string]::IsNullOrWhiteSpace($Path)) {
            return
        }
        if (-not (Test-Path -LiteralPath $Path)) {
            return
        }
        $resolved = (Resolve-Path -LiteralPath $Path).Path
        if (-not $sdkCandidates.Contains($resolved)) {
            $sdkCandidates.Add($resolved)
        }
    }

    Add-SdkCandidate -Path $env:ANDROID_HOME
    Add-SdkCandidate -Path $env:ANDROID_SDK_ROOT
    if ($env:LOCALAPPDATA) {
        Add-SdkCandidate -Path (Join-Path $env:LOCALAPPDATA "Android\\Sdk")
    }
    if ($env:USERPROFILE) {
        Add-SdkCandidate -Path (Join-Path $env:USERPROFILE "AppData\\Local\\Android\\Sdk")
    }
    Add-SdkCandidate -Path "C:\\Android\\Sdk"

    foreach ($sdkRoot in $sdkCandidates) {
        $adbPath = Join-Path $sdkRoot "platform-tools\\adb.exe"
        if (Test-Path -LiteralPath $adbPath) {
            return @{
                Root = $sdkRoot
                Adb = $adbPath
            }
        }
    }

    if ($sdkCandidates.Count -gt 0) {
        return @{
            Root = $sdkCandidates[0]
            Adb = $null
        }
    }

    return $null
}

function Get-JavaHomeInfo {
    $javaCandidates = New-Object System.Collections.Generic.List[string]

    function Add-JavaCandidate {
        param([string]$Path)
        if ([string]::IsNullOrWhiteSpace($Path)) {
            return
        }
        if (-not (Test-Path -LiteralPath $Path)) {
            return
        }
        $resolved = (Resolve-Path -LiteralPath $Path).Path
        if (-not $javaCandidates.Contains($resolved)) {
            $javaCandidates.Add($resolved)
        }
    }

    Add-JavaCandidate -Path $env:JAVA_HOME
    Add-JavaCandidate -Path "$env:ProgramFiles\Android\Android Studio\jbr"
    Add-JavaCandidate -Path "$env:ProgramFiles\Android\Android Studio\jre"

    foreach ($javaHome in $javaCandidates) {
        $javaExe = Join-Path $javaHome "bin\java.exe"
        if (Test-Path -LiteralPath $javaExe) {
            return @{
                Home = $javaHome
                JavaExe = $javaExe
            }
        }
    }

    return $null
}

function Ensure-AndroidGradleArchitectures {
    param([Parameter(Mandatory = $true)][string]$MobileDir)

    $gradlePropsPath = Join-Path $MobileDir "android\gradle.properties"
    if (-not (Test-Path -LiteralPath $gradlePropsPath)) {
        Write-Host "Android gradle.properties not found yet (skip architecture patch)." -ForegroundColor DarkYellow
        return
    }

    $content = Get-Content -LiteralPath $gradlePropsPath -Raw
    $desiredLine = "reactNativeArchitectures=arm64-v8a,x86_64"
    $updated = [regex]::Replace(
        $content,
        "(?m)^reactNativeArchitectures=.*$",
        $desiredLine
    )

    if ($updated -ne $content) {
        Set-Content -LiteralPath $gradlePropsPath -Value $updated -NoNewline
        Write-Host "Patched Android architectures to arm64-v8a,x86_64." -ForegroundColor Cyan
    }
}

$repoRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$backendDir = Join-Path $repoRoot "backend"
$mobileDir = Join-Path $repoRoot "mobile"
$venvDir = Join-Path $backendDir ".venv"
$venvPython = $null
$runPlatform = $Platform
$androidSdkInfo = $null
$javaHomeInfo = $null

if ($CleanInstall -and $SkipInstall) {
    throw "Cannot use -CleanInstall together with -SkipInstall."
}

if (-not (Test-Path -LiteralPath $backendDir)) {
    throw "Missing backend directory: $backendDir"
}
if (-not (Test-Path -LiteralPath $mobileDir)) {
    throw "Missing mobile directory: $mobileDir"
}

if ($CleanInstall) {
    Write-Host "Clean install requested. Removing existing backend/mobile build artifacts..." -ForegroundColor Yellow
    Remove-PathIfExists -Path (Join-Path $backendDir ".venv")
    Remove-PathIfExists -Path (Join-Path $mobileDir "node_modules")
    Remove-PathIfExists -Path (Join-Path $mobileDir "android")
    Remove-PathIfExists -Path (Join-Path $mobileDir ".expo")
    Remove-PathIfExists -Path (Join-Path $mobileDir ".gradle")
}

Assert-Command "node"
Assert-Command "cmd"

if ($Platform -eq "android") {
    $androidSdkInfo = Get-AndroidSdkInfo
    $javaHomeInfo = Get-JavaHomeInfo
    if (-not $androidSdkInfo -or -not $androidSdkInfo.Root -or -not $androidSdkInfo.Adb) {
        Write-Host "Android SDK/adb not found. Falling back to Metro-only mode." -ForegroundColor Yellow
        Write-Host "Install Android Studio SDK + platform-tools, then set ANDROID_HOME." -ForegroundColor Yellow
        $runPlatform = "none"
    } elseif (-not $javaHomeInfo -or -not $javaHomeInfo.Home) {
        Write-Host "Java/JDK not found. Falling back to Metro-only mode." -ForegroundColor Yellow
        Write-Host "Install Android Studio (bundled JBR) or set JAVA_HOME." -ForegroundColor Yellow
        $runPlatform = "none"
    }
}

$pythonForVenv = Get-WorkingPythonForVenv -BackendDir $backendDir
$venvPython = Ensure-VenvPython -BackendDir $backendDir -PythonForVenv $pythonForVenv

if (-not $SkipInstall) {
    Write-Host "Installing backend dependencies..." -ForegroundColor Cyan
}
Ensure-BackendDependencies -BackendDir $backendDir -PythonExe $venvPython -ForceInstall:([bool](-not $SkipInstall))

if (-not $SkipInstall) {
    Write-Host "Installing mobile dependencies..." -ForegroundColor Cyan
}
Ensure-MobileDependencies -MobileDir $mobileDir -ForceInstall:([bool](-not $SkipInstall))
Ensure-VisionCameraAndroidDevicePatch -MobileDir $mobileDir

if (-not $SkipInstall) {
    Push-Location $mobileDir
    try {
        if ($runPlatform -eq "android" -and ($CleanInstall -or -not (Test-Path -LiteralPath "android"))) {
            $prebuildArgs = @("/c", "npx", "expo", "prebuild", "--platform", "android")
            if ($CleanInstall) {
                $prebuildArgs = @("/c", "npx", "expo", "prebuild", "--clean", "--platform", "android")
            }
            Invoke-ExternalChecked -Executable "cmd" -Arguments $prebuildArgs -Description "Expo prebuild android"
        }
        if ($runPlatform -eq "ios" -and ($CleanInstall -or -not (Test-Path -LiteralPath "ios"))) {
            $prebuildArgs = @("/c", "npx", "expo", "prebuild", "--platform", "ios")
            if ($CleanInstall) {
                $prebuildArgs = @("/c", "npx", "expo", "prebuild", "--clean", "--platform", "ios")
            }
            Invoke-ExternalChecked -Executable "cmd" -Arguments $prebuildArgs -Description "Expo prebuild ios"
        }
    }
    finally {
        Pop-Location
    }
}

if ($runPlatform -eq "android") {
    Ensure-AndroidGradleArchitectures -MobileDir $mobileDir
}

if ($runPlatform -eq "android") {
    Ensure-AndroidPoseDetectorPlugin -MobileDir $mobileDir
}

$expoPkgCheck = Join-Path $mobileDir "node_modules\\expo\\package.json"
if (-not (Test-Path -LiteralPath $expoPkgCheck)) {
    throw "Mobile dependencies are missing (expo not found). Run without -SkipInstall once."
}

if (-not $venvPython) {
    $venvPython = Ensure-VenvPython -BackendDir $backendDir -PythonForVenv $pythonForVenv
}

if (-not $venvPython) {
    throw "Virtualenv Python not found under: $venvDir"
}
Write-Host "Backend Python: $venvPython" -ForegroundColor DarkGray

Write-Host "Starting backend on http://$BackendHost`:$BackendPort ..." -ForegroundColor Green
$backendCommand = @"
Set-Location -LiteralPath '$backendDir'
& '$venvPython' -m uvicorn app.main:app --reload --host $BackendHost --port $BackendPort
"@
Start-DetachedPowerShell -Command $backendCommand -Title "Pose Backend"

$androidEnvBootstrap = ""
if ($runPlatform -eq "android" -and $androidSdkInfo -and $androidSdkInfo.Root) {
    $safeSdk = $androidSdkInfo.Root.Replace("'", "''")
    $safeJava = ""
    if ($javaHomeInfo -and $javaHomeInfo.Home) {
        $safeJava = $javaHomeInfo.Home.Replace("'", "''")
    }
    $androidEnvBootstrap = @"
`$env:ANDROID_HOME = '$safeSdk'
`$env:ANDROID_SDK_ROOT = '$safeSdk'
`$env:JAVA_HOME = '$safeJava'
`$env:Path = '$safeSdk\platform-tools;$safeSdk\cmdline-tools\latest\bin;$safeJava\bin;' + `$env:Path
"@
}

if ($runPlatform -eq "none") {
    Write-Host "Starting Expo Dev Client Metro server..." -ForegroundColor Green
    $mobileCommand = @"
Set-Location -LiteralPath '$mobileDir'
cmd /c npm run start
"@
    Start-DetachedPowerShell -Command $mobileCommand -Title "Pose Mobile (Metro)"
}
else {
    Write-Host "Starting Expo native run for platform '$runPlatform'..." -ForegroundColor Green
    $expoRunCommand = if ($runPlatform -eq "android") {
        "cmd /c npx expo run:android --all-arch"
    }
    else {
        "cmd /c npx expo run:$runPlatform"
    }
    $mobileCommand = @"
Set-Location -LiteralPath '$mobileDir'
$androidEnvBootstrap
$expoRunCommand
"@
    Start-DetachedPowerShell -Command $mobileCommand -Title "Pose Mobile ($runPlatform)"
}

Write-Host ""
Write-Host "Launched. Open windows:" -ForegroundColor Yellow
Write-Host "  1) Pose Backend" -ForegroundColor Yellow
Write-Host "  2) Pose Mobile" -ForegroundColor Yellow
Write-Host ""
Write-Host "Tip: Use -SkipInstall on later runs to start faster." -ForegroundColor DarkGray
