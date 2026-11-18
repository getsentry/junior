# Install the tools that the scripts and fastlane lanes in this folder use.
.PHONY: init
init:
	brew install xcodegen xcbeautify jq rbenv
	rbenv install --skip-existing
	rbenv exec bundle install

# Generate Junior.xcodeproj from project.yml and open it.
.PHONY: xcode
xcode:
	xcodegen generate
	open Junior.xcodeproj
