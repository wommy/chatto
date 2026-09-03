package main

import "hmans.de/chatto/cmd"

// Verify desktop skip path for PR #109 - this is a test-only change
func main() {
	cmd.SetVersion(Version)
	cmd.Execute()
}
