//! Preserve macOS file access rules across inode replacement.
use sha2::{Digest, Sha256};
use std::collections::BTreeMap;
use std::ffi::OsString;
use std::ffi::c_void;
use std::fs::File;
use std::io;
use std::mem::MaybeUninit;
use std::os::fd::AsRawFd;
use std::os::macos::fs::MetadataExt as DarwinMetadataExt;
use std::os::unix::fs::MetadataExt;
use std::os::unix::fs::PermissionsExt;
use std::ptr::NonNull;
use xattr::FileExt;

// Darwin represents the full, ordered ACL (including inherited flags) through
// these functions in <sys/acl.h>. A null result with ENOENT means no ACL.
unsafe extern "C" {
    fn acl_get_fd(fd: libc::c_int) -> *mut c_void;
    fn acl_init(count: libc::c_int) -> *mut c_void;
    fn acl_set_fd(fd: libc::c_int, acl: *mut c_void) -> libc::c_int;
    fn acl_free(acl: *mut c_void) -> libc::c_int;
    fn acl_size(acl: *mut c_void) -> libc::ssize_t;
    fn acl_copy_ext(buf: *mut c_void, acl: *mut c_void, size: libc::ssize_t) -> libc::ssize_t;
}

struct Acl(NonNull<c_void>);

impl Drop for Acl {
    fn drop(&mut self) {
        unsafe { acl_free(self.0.as_ptr()) };
    }
}

impl Acl {
    fn read(file: &File) -> io::Result<Option<Self>> {
        let Some(ptr) = NonNull::new(unsafe { acl_get_fd(file.as_raw_fd()) }) else {
            let error = io::Error::last_os_error();
            if error.kind() == io::ErrorKind::NotFound {
                return Ok(None);
            }
            return Err(error);
        };
        Ok(Some(Self(ptr)))
    }

    fn empty() -> io::Result<Self> {
        NonNull::new(unsafe { acl_init(0) })
            .map(Self)
            .ok_or_else(io::Error::last_os_error)
    }

    fn apply(&self, file: &File) -> io::Result<()> {
        if unsafe { acl_set_fd(file.as_raw_fd(), self.0.as_ptr()) } != 0 {
            return Err(io::Error::last_os_error());
        }
        Ok(())
    }

    fn bytes(&self) -> io::Result<Vec<u8>> {
        let size = unsafe { acl_size(self.0.as_ptr()) };
        let mut data = vec![0; usize::try_from(size).map_err(|_| io::Error::last_os_error())?];
        if unsafe { acl_copy_ext(data.as_mut_ptr().cast(), self.0.as_ptr(), size) } != size {
            return Err(io::Error::last_os_error());
        }
        Ok(data)
    }
}

// Darwin's extended stat captures the mode, ownership and ACL together. Its
// extended chmod installs the same security descriptor with one kernel request.
unsafe extern "C" {
    fn filesec_init() -> *mut c_void;
    fn filesec_free(sec: *mut c_void);
    fn filesec_get_property(
        sec: *mut c_void,
        property: libc::c_int,
        value: *mut c_void,
    ) -> libc::c_int;
    fn filesec_set_property(
        sec: *mut c_void,
        property: libc::c_int,
        value: *const c_void,
    ) -> libc::c_int;
    #[cfg_attr(target_arch = "x86_64", link_name = "fstatx_np$INODE64")]
    fn fstatx_np(fd: libc::c_int, stat: *mut libc::stat, sec: *mut c_void) -> libc::c_int;
    fn fchmodx_np(fd: libc::c_int, sec: *mut c_void) -> libc::c_int;
}

struct SecurityDescriptor(NonNull<c_void>);

impl Drop for SecurityDescriptor {
    fn drop(&mut self) {
        unsafe { filesec_free(self.0.as_ptr()) };
    }
}

pub(crate) struct FileAccess {
    descriptor: SecurityDescriptor,
    uid: libc::uid_t,
    gid: libc::gid_t,
    mode: libc::mode_t,
    acl: Option<Vec<u8>>,
}

impl FileAccess {
    pub(crate) fn capture(file: &File) -> io::Result<Self> {
        // FILESEC_ACL is defined in Darwin's <sys/fcntl.h>.
        const FILESEC_ACL: libc::c_int = 5;
        let descriptor = SecurityDescriptor(
            NonNull::new(unsafe { filesec_init() }).ok_or_else(io::Error::last_os_error)?,
        );
        let sec = descriptor.0.as_ptr();
        let mut stat = MaybeUninit::uninit();
        if unsafe { fstatx_np(file.as_raw_fd(), stat.as_mut_ptr(), sec) } != 0 {
            return Err(io::Error::last_os_error());
        }
        let stat = unsafe { stat.assume_init() };
        let mut raw_acl: *mut c_void = std::ptr::null_mut();
        let acl = if unsafe { filesec_get_property(sec, FILESEC_ACL, (&raw mut raw_acl).cast()) }
            == 0
        {
            let acl =
                Acl(NonNull::new(raw_acl).ok_or_else(|| io::Error::other("Invalid file ACL."))?);
            Some(acl.bytes()?)
        } else {
            let error = io::Error::last_os_error();
            if error.kind() != io::ErrorKind::NotFound {
                return Err(error);
            }
            // An omitted ACL leaves the destination's ACL intact. Supply an
            // explicit empty ACL so applying this snapshot also clears one.
            let empty = Acl::empty()?;
            let ptr = empty.0.as_ptr();
            if unsafe { filesec_set_property(sec, FILESEC_ACL, (&raw const ptr).cast()) } != 0 {
                return Err(io::Error::last_os_error());
            }
            None
        };
        Ok(Self {
            descriptor,
            uid: stat.st_uid,
            gid: stat.st_gid,
            mode: stat.st_mode,
            acl,
        })
    }

    pub(crate) fn matches(&self, file: &File) -> io::Result<bool> {
        let target = Self::capture(file)?;
        Ok((self.uid, self.gid, self.mode, &self.acl)
            == (target.uid, target.gid, target.mode, &target.acl))
    }

    pub(crate) fn apply(&self, file: &File) -> io::Result<()> {
        if unsafe { fchmodx_np(file.as_raw_fd(), self.descriptor.0.as_ptr()) } != 0 {
            return Err(io::Error::last_os_error());
        }
        Ok(())
    }
}

// The working pathname can be observed as soon as the exchange returns. Keep
// the resolution inaccessible there until its displaced predecessor is checked.
pub(crate) fn withhold_access(file: &File) -> io::Result<()> {
    let uid = unsafe { libc::geteuid() };
    if file.metadata()?.uid() != uid
        && unsafe { libc::fchown(file.as_raw_fd(), uid, libc::gid_t::MAX) } != 0
    {
        return Err(io::Error::last_os_error());
    }
    file.set_permissions(std::fs::Permissions::from_mode(0o000))?;
    if Acl::read(file)?.is_some() {
        Acl::empty()?.apply(file)?;
    }
    Ok(())
}

/// Copy and verify owner, group, POSIX permissions and the full ACL.
/// The file bytes and modification time belong to the caller.
///
/// # Errors
/// Returns an error if the filesystem cannot reproduce the source access rules.
pub fn copy_file_access(source: &File, target: &File) -> io::Result<()> {
    let access = FileAccess::capture(source)?;
    access.apply(target)?;
    if !access.matches(source)? || !access.matches(target)? {
        return Err(io::Error::other(
            "Could not preserve file ownership, permissions and access control list.",
        ));
    }
    Ok(())
}

// Darwin checks read access even on the held descriptor when listing xattrs,
// so capture the prepared file's metadata before making that inode inaccessible.
#[derive(PartialEq, Eq)]
pub(crate) struct FileAttributes {
    flags: u32,
    values: BTreeMap<OsString, [u8; 32]>,
}

impl FileAttributes {
    pub(crate) fn capture(file: &File) -> io::Result<Self> {
        let flags = file.metadata()?.st_flags();
        let mut values = BTreeMap::new();
        for name in file.list_xattr()? {
            let hash = if name == "com.apple.ResourceFork" {
                resource_fork_digest(file)?
            } else {
                Sha256::digest(file.get_xattr(&name)?.ok_or_else(|| {
                    io::Error::other("The file's extended attributes changed during Save.")
                })?)
                .into()
            };
            values.insert(name, hash);
        }
        Ok(Self { flags, values })
    }
}

// Darwin reads resource forks in partial chunks. Ordinary one-buffer xattr
// reads can silently return a prefix of the fork.
fn resource_fork_digest(file: &File) -> io::Result<[u8; 32]> {
    const CHUNK: u32 = 32 * 1024;
    let mut digest = Sha256::new();
    let mut buffer = vec![0; CHUNK as usize];
    let mut position = 0u32;
    loop {
        let len = unsafe {
            libc::fgetxattr(
                file.as_raw_fd(),
                c"com.apple.ResourceFork".as_ptr(),
                buffer.as_mut_ptr().cast(),
                buffer.len(),
                position,
                0,
            )
        };
        let len = usize::try_from(len).map_err(|_| io::Error::last_os_error())?;
        digest.update(&buffer[..len]);
        if len < buffer.len() {
            return Ok(digest.finalize().into());
        }
        position = position.checked_add(CHUNK).ok_or_else(|| {
            io::Error::other("The resource fork exceeds the filesystem comparison range.")
        })?;
    }
}

fn verify_directory_owner_mode(dir: &File) -> io::Result<()> {
    let meta = dir.metadata()?;
    if !meta.is_dir() || meta.uid() != unsafe { libc::geteuid() } || meta.mode() & 0o777 != 0o700 {
        return Err(io::Error::other(
            "Private directories must belong to you and have mode 0700.",
        ));
    }
    Ok(())
}

/// Remove ACLs inherited from the parent of a newly created private directory.
///
/// # Errors
/// Refuses directories with another owner or mode and reports ACL errors.
pub fn privatize_new_directory(dir: &File) -> io::Result<()> {
    verify_directory_owner_mode(dir)?;
    if Acl::read(dir)?.is_some() {
        Acl::empty()?.apply(dir)?;
    }
    Ok(())
}

/// Check an existing private directory without changing its access rules.
///
/// # Errors
/// Rejects directories with another owner, broader mode or an extended ACL.
pub fn verify_private_directory(dir: &File) -> io::Result<()> {
    verify_directory_owner_mode(dir)?;
    if Acl::read(dir)?.is_some() {
        return Err(io::Error::other(
            "The recovery directory has an access control list.",
        ));
    }
    Ok(())
}
