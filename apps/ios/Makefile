# Install the tools that the scripts and fastlane lanes in this folder use.
.PHONY: init
init:
	brew bundle --file=Brewfile
	rbenv install --skip-existing
	rbenv exec bundle install

# Generate Junior.xcodeproj from project.yml.
.PHONY: xcodegen
xcodegen:
	xcodegen generate

# Generate the project and open it in Xcode.
.PHONY: xcode
xcode: xcodegen
	open Junior.xcodeproj
