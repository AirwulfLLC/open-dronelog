//! Dynamic FFI bindings for the DJI Thermal SDK (libdirp).
//!
//! The SDK ships as a set of native libraries (libdirp.dll / libdirp.so plus
//! sub-libraries it loads itself). We load libdirp at runtime with `libloading`
//! so the app still builds and runs on platforms where the SDK is absent —
//! thermal features simply report "SDK unavailable" there.
//!
//! Supported: Windows x64 and Linux x64 desktop builds.

use std::ffi::c_void;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};

use libloading::Library;

pub const DIRP_SUCCESS: i32 = 0;

/// `dirp_resolution_t`
#[repr(C, packed)]
#[derive(Clone, Copy, Debug, Default)]
pub struct DirpResolution {
    pub width: i32,
    pub height: i32,
}

/// `dirp_measurement_params_t`
#[repr(C, packed)]
#[derive(Clone, Copy, Debug, Default)]
pub struct DirpMeasurementParams {
    pub distance: f32,
    pub humidity: f32,
    pub emissivity: f32,
    pub reflection: f32,
    pub ambient_temp: f32,
}

type DirpHandle = *mut c_void;

type FnCreateFromRjpeg = unsafe extern "C" fn(*const u8, i32, *mut DirpHandle) -> i32;
type FnDestroy = unsafe extern "C" fn(DirpHandle) -> i32;
type FnGetResolution = unsafe extern "C" fn(DirpHandle, *mut DirpResolution) -> i32;
type FnMeasureEx = unsafe extern "C" fn(DirpHandle, *mut f32, i32) -> i32;
type FnGetMeasurementParams = unsafe extern "C" fn(DirpHandle, *mut DirpMeasurementParams) -> i32;
type FnSetMeasurementParams = unsafe extern "C" fn(DirpHandle, *const DirpMeasurementParams) -> i32;
type FnSetVerboseLevel = unsafe extern "C" fn(i32);

/// Resolved function pointers, kept alive by `_lib`.
struct SdkInner {
    _lib: Library,
    sdk_dir: PathBuf,
    create_from_rjpeg: FnCreateFromRjpeg,
    destroy: FnDestroy,
    get_resolution: FnGetResolution,
    measure_ex: FnMeasureEx,
    get_measurement_params: FnGetMeasurementParams,
    set_measurement_params: FnSetMeasurementParams,
}

// Raw pointers inside are only used behind the global SDK_LOCK mutex.
unsafe impl Send for SdkInner {}
unsafe impl Sync for SdkInner {}

static SDK: OnceLock<Result<SdkInner, String>> = OnceLock::new();
/// The SDK's thread-safety is undocumented; serialize all calls.
static SDK_LOCK: Mutex<()> = Mutex::new(());

#[cfg(windows)]
fn lib_file_name() -> &'static str {
    "libdirp.dll"
}
#[cfg(not(windows))]
fn lib_file_name() -> &'static str {
    "libdirp.so"
}

/// On Windows, dependent DLLs (libv_dirp.dll, …) are resolved through the
/// process DLL search path, so add the SDK directory to it before loading.
#[cfg(windows)]
fn add_dll_directory(dir: &Path) {
    use std::os::windows::ffi::OsStrExt;
    let wide: Vec<u16> = dir.as_os_str().encode_wide().chain(std::iter::once(0)).collect();
    extern "system" {
        fn SetDllDirectoryW(lp_path_name: *const u16) -> i32;
    }
    unsafe {
        SetDllDirectoryW(wide.as_ptr());
    }
}

#[cfg(not(windows))]
fn add_dll_directory(_dir: &Path) {}

/// Candidate directories that may contain libdirp, in priority order.
fn candidate_dirs() -> Vec<PathBuf> {
    let mut dirs: Vec<PathBuf> = Vec::new();

    // 1. Explicit override
    if let Ok(dir) = std::env::var("DJI_TSDK_DIR") {
        dirs.push(PathBuf::from(dir));
    }

    // 2. Next to the executable (release bundles place the SDK in `tsdk/`)
    if let Ok(exe) = std::env::current_exe() {
        if let Some(exe_dir) = exe.parent() {
            dirs.push(exe_dir.join("tsdk"));
            dirs.push(exe_dir.to_path_buf());
        }
    }

    // 3. Development checkout (repo `deps/` folder)
    #[cfg(windows)]
    let platform = "windows";
    #[cfg(not(windows))]
    let platform = "linux";
    let dev = Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("..")
        .join("deps")
        .join("dji_thermal_sdk")
        .join("tsdk-core")
        .join("lib")
        .join(platform)
        .join("release_x64");
    dirs.push(dev);

    dirs
}

fn load_sdk() -> Result<SdkInner, String> {
    if !cfg!(target_pointer_width = "64") {
        return Err("DJI Thermal SDK requires a 64-bit build".to_string());
    }
    if cfg!(target_os = "android") || cfg!(target_os = "ios") {
        return Err("DJI Thermal SDK is not available on mobile platforms".to_string());
    }

    let mut last_err = String::from("libdirp not found in any known location");
    for dir in candidate_dirs() {
        let lib_path = dir.join(lib_file_name());
        if !lib_path.exists() {
            continue;
        }
        add_dll_directory(&dir);
        match unsafe { Library::new(&lib_path) } {
            // Resolve all symbols up front; on failure fall through to the
            // next candidate directory (a stale DJI_TSDK_DIR or leftover DLL
            // must not shadow a good install later in the list).
            Ok(lib) => match unsafe { resolve_symbols(lib, dir.clone()) } {
                Ok(inner) => {
                    log::info!("DJI Thermal SDK loaded from {}", dir.display());
                    return Ok(inner);
                }
                Err(e) => {
                    last_err = format!("{}: {e}", lib_path.display());
                    log::warn!("{last_err}");
                }
            },
            Err(e) => {
                last_err = format!("failed to load {}: {e}", lib_path.display());
                log::warn!("{last_err}");
            }
        }
    }
    Err(last_err)
}

unsafe fn resolve_symbols(lib: Library, sdk_dir: PathBuf) -> Result<SdkInner, String> {
    let create_from_rjpeg = *lib
        .get::<FnCreateFromRjpeg>(b"dirp_create_from_rjpeg\0")
        .map_err(|e| format!("missing symbol dirp_create_from_rjpeg: {e}"))?;
    let destroy = *lib
        .get::<FnDestroy>(b"dirp_destroy\0")
        .map_err(|e| format!("missing symbol dirp_destroy: {e}"))?;
    let get_resolution = *lib
        .get::<FnGetResolution>(b"dirp_get_rjpeg_resolution\0")
        .map_err(|e| format!("missing symbol dirp_get_rjpeg_resolution: {e}"))?;
    let measure_ex = *lib
        .get::<FnMeasureEx>(b"dirp_measure_ex\0")
        .map_err(|e| format!("missing symbol dirp_measure_ex: {e}"))?;
    let get_measurement_params = *lib
        .get::<FnGetMeasurementParams>(b"dirp_get_measurement_params\0")
        .map_err(|e| format!("missing symbol dirp_get_measurement_params: {e}"))?;
    let set_measurement_params = *lib
        .get::<FnSetMeasurementParams>(b"dirp_set_measurement_params\0")
        .map_err(|e| format!("missing symbol dirp_set_measurement_params: {e}"))?;
    // Optional: silence SDK console logging if the symbol exists.
    if let Ok(set_verbose) = lib.get::<FnSetVerboseLevel>(b"dirp_set_verbose_level\0") {
        (*set_verbose)(0);
    }
    Ok(SdkInner {
        sdk_dir,
        create_from_rjpeg,
        destroy,
        get_resolution,
        measure_ex,
        get_measurement_params,
        set_measurement_params,
        _lib: lib,
    })
}

fn sdk() -> Result<&'static SdkInner, String> {
    match SDK.get_or_init(load_sdk) {
        Ok(inner) => Ok(inner),
        Err(e) => Err(e.clone()),
    }
}

/// Status of the SDK for surfacing in the UI.
pub fn sdk_status() -> (bool, Option<String>, Option<String>) {
    match sdk() {
        Ok(inner) => (true, Some(inner.sdk_dir.display().to_string()), None),
        Err(e) => (false, None, Some(e)),
    }
}

/// Result of measuring a radiometric JPEG.
pub struct MeasureResult {
    pub width: usize,
    pub height: usize,
    /// Per-pixel temperature in °C, row-major.
    pub temps: Vec<f32>,
    pub params: DirpMeasurementParams,
}

/// Override values for measurement parameters (all optional).
#[derive(Clone, Copy, Debug, Default, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MeasureOverrides {
    pub distance: Option<f32>,
    pub humidity: Option<f32>,
    pub emissivity: Option<f32>,
    pub reflection: Option<f32>,
    pub ambient_temp: Option<f32>,
}

impl MeasureOverrides {
    pub fn is_empty(&self) -> bool {
        self.distance.is_none()
            && self.humidity.is_none()
            && self.emissivity.is_none()
            && self.reflection.is_none()
            && self.ambient_temp.is_none()
    }
}

fn err_name(code: i32) -> String {
    let name = match code {
        -1 => "MALLOC",
        -2 => "POINTER_NULL",
        -3 => "INVALID_PARAMS",
        -4 => "INVALID_RAW",
        -5 => "INVALID_HEADER",
        -6 => "INVALID_CURVE",
        -7 => "RJPEG_PARSE",
        -8 => "SIZE",
        -9 => "INVALID_HANDLE",
        -10 => "FORMAT_INPUT",
        -11 => "FORMAT_OUTPUT",
        -12 => "UNSUPPORTED_FUNC",
        -13 => "NOT_READY",
        -14 => "ACTIVATION",
        -15 => "INVALID_INI",
        -16 => "INVALID_SUB_DLL",
        -64 => "SUPER_MODE",
        _ => "UNKNOWN",
    };
    format!("DIRP error {code} ({name})")
}

/// Quick check: is this file a radiometric JPEG the SDK can open?
pub fn is_radiometric(jpeg_bytes: &[u8]) -> bool {
    let Ok(inner) = sdk() else { return false };
    let _guard = SDK_LOCK.lock().unwrap();
    let mut handle: DirpHandle = std::ptr::null_mut();
    let ret = unsafe {
        (inner.create_from_rjpeg)(jpeg_bytes.as_ptr(), jpeg_bytes.len() as i32, &mut handle)
    };
    if ret == DIRP_SUCCESS && !handle.is_null() {
        unsafe {
            (inner.destroy)(handle);
        }
        true
    } else {
        false
    }
}

/// Measure the full temperature matrix of a radiometric JPEG.
pub fn measure(jpeg_bytes: &[u8], overrides: MeasureOverrides) -> Result<MeasureResult, String> {
    let inner = sdk()?;
    let _guard = SDK_LOCK.lock().unwrap();

    let mut handle: DirpHandle = std::ptr::null_mut();
    let ret = unsafe {
        (inner.create_from_rjpeg)(jpeg_bytes.as_ptr(), jpeg_bytes.len() as i32, &mut handle)
    };
    if ret != DIRP_SUCCESS || handle.is_null() {
        return Err(format!("Failed to open R-JPEG: {}", err_name(ret)));
    }

    // From here on, always destroy the handle before returning.
    let result = (|| {
        let mut resolution = DirpResolution::default();
        let ret = unsafe { (inner.get_resolution)(handle, &mut resolution) };
        if ret != DIRP_SUCCESS {
            return Err(format!("Failed to read resolution: {}", err_name(ret)));
        }
        let (w, h) = (resolution.width as usize, resolution.height as usize);
        if w == 0 || h == 0 || w > 8192 || h > 8192 {
            return Err(format!("Unexpected thermal resolution {w}x{h}"));
        }

        let mut params = DirpMeasurementParams::default();
        let ret = unsafe { (inner.get_measurement_params)(handle, &mut params) };
        if ret != DIRP_SUCCESS {
            return Err(format!("Failed to read measurement params: {}", err_name(ret)));
        }

        if !overrides.is_empty() {
            let new_params = DirpMeasurementParams {
                distance: overrides.distance.unwrap_or(params.distance),
                humidity: overrides.humidity.unwrap_or(params.humidity),
                emissivity: overrides.emissivity.unwrap_or(params.emissivity),
                reflection: overrides.reflection.unwrap_or(params.reflection),
                ambient_temp: overrides.ambient_temp.unwrap_or(params.ambient_temp),
            };
            let ret = unsafe { (inner.set_measurement_params)(handle, &new_params) };
            if ret != DIRP_SUCCESS {
                return Err(format!("Failed to set measurement params: {}", err_name(ret)));
            }
            params = new_params;
        }

        let mut temps = vec![0f32; w * h];
        let byte_len = (temps.len() * std::mem::size_of::<f32>()) as i32;
        let ret = unsafe { (inner.measure_ex)(handle, temps.as_mut_ptr(), byte_len) };
        if ret != DIRP_SUCCESS {
            return Err(format!("Temperature measurement failed: {}", err_name(ret)));
        }

        Ok(MeasureResult {
            width: w,
            height: h,
            temps,
            params,
        })
    })();

    unsafe {
        (inner.destroy)(handle);
    }
    result
}
