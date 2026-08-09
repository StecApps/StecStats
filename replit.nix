{pkgs}: {
  deps = [
    pkgs.eas-cli
    pkgs.libxkbcommon
    pkgs.chromium
    pkgs.libGL
    pkgs.alsa-lib
    pkgs.cairo
    pkgs.pango
    pkgs.mesa
    pkgs.xorg.libxcb
    pkgs.xorg.libXrandr
    pkgs.xorg.libXfixes
    pkgs.xorg.libXext
    pkgs.xorg.libXdamage
    pkgs.xorg.libXcomposite
    pkgs.xorg.libX11
    pkgs.expat
    pkgs.dbus
    pkgs.libdrm
    pkgs.cups
    pkgs.atk
    pkgs.nspr
    pkgs.nss
    pkgs.glib
    pkgs.ffmpeg
  ];
}
