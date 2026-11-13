class BellReader < Formula
  desc "Local-first web article snapshot and organic ink annotation reader"
  homepage "https://github.com/Suzu1Dev/bell-reader"
  url "https://github.com/Suzu1Dev/bell-reader/archive/refs/heads/main.tar.gz"
  version "1.0.2"
  license "Apache-2.0"
  head "https://github.com/Suzu1Dev/bell-reader.git", branch: "main"

  depends_on "node"
  depends_on "git"

  def install
    system "npm", "install", *std_npm_args(ignore_scripts: false)
    bin.install_symlink libexec.glob("bin/*")
  end

  test do
    assert_match version.to_s, shell_output("#{bin}/bell-reader --version")
    assert_match "doctor", shell_output("#{bin}/bell-reader --help")
  end
end
