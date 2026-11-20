# Install the tools that the scripts and fastlane lanes in this folder use.
.PHONY: init
init:
	brew bundle --file=Brewfile
	rbenv install --skip-existing
	rbenv exec bundle install

# Put the match development certificate and profile on this Mac, for device builds.
.PHONY: signing
signing:
	rbenv exec bundle exec fastlane match development

# Generate Junior.xcodeproj from project.yml.
.PHONY: xcodegen
xcodegen:
	xcodegen generate

# Generate the project and open it in Xcode.
.PHONY: xcode
xcode: xcodegen
	open Junior.xcodeproj
