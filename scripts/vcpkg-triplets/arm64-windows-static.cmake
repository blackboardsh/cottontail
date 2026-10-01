set(VCPKG_TARGET_ARCHITECTURE arm64)
set(VCPKG_CRT_LINKAGE static)
set(VCPKG_LIBRARY_LINKAGE static)

# OpenSSL's /Gs0 triggers an MSVC ARM64 register-clobber miscompilation in MD4.
# Restore the normal stack-probe threshold after OpenSSL's configuration flags;
# /GS stack cookies and probes for large frames remain enabled.
# https://github.com/openssl/openssl/pull/32872
set(VCPKG_C_FLAGS "/Gs4096")
set(VCPKG_CXX_FLAGS "/Gs4096")
